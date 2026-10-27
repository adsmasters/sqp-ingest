// Vendor-Sales-Import für das Vendor-Reporting-Tool (vra_*-Tabellen).
// Zieht je Kunde (vra_clients mit spid) GET_VENDOR_SALES_REPORT:
//  - fehlende komplette Monate rückwirkend (MONTH-Report, Default 12 Monate)
//  - laufenden Monat als Teilmonat (DAY-Report, per ASIN aggregiert), wird bei jedem Lauf ersetzt
// Titel/Marke je ASIN aus bestehenden vra_data-Zeilen, sonst Catalog Items API.
// Ersetzt den manuellen Excel-Upload aus Vendor Central Retail Analytics (Sichtweite: Hersteller).
// ENV: SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: SINCE (YYYY-MM, ziehe rückwirkend bis inkl. diesen Monat),
//           MONTHS (Anzahl, Default 12; SINCE hat Vorrang), CLIENT (Name-Filter)
import zlib from 'node:zlib';
const CID=process.env.SPAPI_CLIENT_ID, SEC=process.env.SPAPI_CLIENT_SECRET;
const U=process.env.SUPABASE_URL, KEY=process.env.SUPABASE_SERVICE_KEY;
const SPAPI='https://sellingpartnerapi-eu.amazon.com';
const NMONTHS=+(process.env.MONTHS||12);
const SINCE=/^\d{4}-\d{2}$/.test(process.env.SINCE||'')?process.env.SINCE:null;
const ONLY=(process.env.CLIENT||'').trim().toLowerCase();
const MKT_BY_CC={DE:'A1PA6795UKMFR9',FR:'A13V1IB3VIYZZH',IT:'APJ6JRA9NG5V4',ES:'A1RKKUPIHCS9HS',UK:'A1F83G8C2ARO7P',NL:'A1805IZSGTT6HS',SE:'A2NODRKZP88ZB9',PL:'A1C3SOZRARQ6R3',BE:'AMEN7PMS3EDWL'};
const sbHead={apikey:KEY,Authorization:'Bearer '+KEY};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Download mit Retry bei Netzwerk-/HTTP-Fehlern, inkl. Body-Lesen (z. B. S3-Connect-Timeout beim Report-Download); wirft nach dem letzten Versuch
async function fetchBuf(url,tries=5){ for(let i=1;;i++){ try{ const r=await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); return Buffer.from(await r.arrayBuffer()); }catch(e){ if(i>=tries) throw e; console.log(`    Netzwerkfehler (${(e.cause&&e.cause.code)||e.message}) — Retry ${i}/${tries-1}`); await sleep(5000*i); } } }
const iso=d=>d.toISOString().slice(0,10);

async function accessToken(spid){
  const r=await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${encodeURIComponent(spid)}&select=refresh_token`,{headers:sbHead});
  const rows=await r.json(); if(!rows[0]) return null;
  const t=await fetch('https://api.amazon.co.uk/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:rows[0].refresh_token,client_id:CID,client_secret:SEC})});
  return (await t.json()).access_token;
}
function makeApi(H){ return async function api(path,opts={},retries=10){
  let netErr=null;
  for(let i=0;i<retries;i++){ let r; try{ r=await fetch(`${SPAPI}${path}`,{...opts,headers:{...H,...(opts.headers||{})}}); }catch(e){ netErr=e; if(i<retries-1){ console.log(`    Netzwerkfehler (${(e.cause&&e.cause.code)||e.message}) — Retry ${i+1}/${retries-1}`); await sleep(5000*(i+1)); } continue; }
    netErr=null; if(r.status===429){ if(i<retries-1) await sleep(25000+Math.random()*10000); continue; } return r; }
  if(netErr) throw netErr; // dauerhafter Netzwerkfehler: laut scheitern statt still "übersprungen"
  return null; }; }
async function pollDoc(api,id){ for(let i=0;i<120;i++){await sleep(5000);const g=await api(`/reports/2021-06-30/reports/${id}`);if(!g)return null;const gj=await g.json();if(gj.processingStatus==='DONE')return gj.reportDocumentId;if(['FATAL','CANCELLED'].includes(gj.processingStatus))return null;} return null; }
async function download(api,docId){ const dr=await api(`/reports/2021-06-30/documents/${docId}`);if(!dr)return null;const drj=await dr.json();if(!drj.url)return null;let buf=await fetchBuf(drj.url);if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);return JSON.parse(buf.toString('utf8')); }

// Vendor-Sales-Report anfordern und salesByAsin zurückgeben (FATAL/429-Erschöpfung/fehlende Download-URL → null, z. B. keine Daten im Zeitraum;
// Netzwerk-/HTTP-Fehler beim Download werfen nach den Retries → Kunde zählt als Fehler)
async function fetchVendorSales(api,mkt,period,start,end){
  const body={reportType:'GET_VENDOR_SALES_REPORT',marketplaceIds:[mkt],
    dataStartTime:start+'T00:00:00Z',dataEndTime:end+'T23:59:59Z',
    reportOptions:{reportPeriod:period,distributorView:'MANUFACTURING',sellingProgram:'RETAIL'}};
  const c=await api('/reports/2021-06-30/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!c||c.status>=400){console.log(`    createReport ${c?c.status:'-'}: ${c?await c.text():''}`);return null;}
  const docId=await pollDoc(api,(await c.json()).reportId);
  if(!docId) return null;
  const doc=await download(api,docId);
  if(!doc) return null; // Download fehlgeschlagen ≠ "keine Daten" (sonst würde ein Teilmonat still ersetzt)
  return Array.isArray(doc.salesByAsin)?doc.salesByAsin:[];
}
const amt=v=>v&&typeof v.amount==='number'?v.amount:0;
const cur=rows=>{for(const r of rows){const c=(r.orderedRevenue&&r.orderedRevenue.currencyCode)||(r.shippedRevenue&&r.shippedRevenue.currencyCode);if(c)return c;}return 'EUR';};

// per ASIN aggregieren (DAY-Reports haben eine Zeile pro ASIN und Tag)
function aggregate(rows){
  const m={};
  for(const r of rows){ if(!r.asin) continue;
    const a=(m[r.asin]??={ordered_revenue:0,ordered_units:0,shipped_revenue:0,shipped_cogs:0,shipped_units:0,customer_returns:0,maxEnd:null});
    a.ordered_revenue+=amt(r.orderedRevenue); a.ordered_units+=r.orderedUnits||0;
    a.shipped_revenue+=amt(r.shippedRevenue); a.shipped_cogs+=amt(r.shippedCogs);
    a.shipped_units+=r.shippedUnits||0; a.customer_returns+=r.customerReturns||0;
    if(r.endDate&&(!a.maxEnd||r.endDate>a.maxEnd)) a.maxEnd=r.endDate; }
  return m;
}

// Titel/Marke: erst aus vorhandenen vra_data des Kunden, Rest über Catalog Items API
async function titleMap(api,clientId,mkt,asins){
  const map={};
  let from=0;
  while(true){ const r=await fetch(`${U}/rest/v1/vra_data?client_id=eq.${clientId}&title=not.is.null&select=asin,title,brand&order=period_start.desc&limit=1000&offset=${from}`,{headers:sbHead});
    const rows=r.ok?await r.json():[]; for(const x of rows){ if(!map[x.asin]) map[x.asin]={title:x.title,brand:x.brand}; }
    if(rows.length<1000) break; from+=1000; }
  const missing=asins.filter(a=>!map[a]);
  for(let i=0;i<missing.length;i+=20){
    const batch=missing.slice(i,i+20);
    const r=await api(`/catalog/2022-04-01/items?identifiers=${batch.join(',')}&identifiersType=ASIN&marketplaceIds=${mkt}&includedData=summaries&pageSize=20`);
    if(!r||!r.ok){await sleep(600);continue;}
    const j=await r.json();
    for(const it of (j.items||[])){ const s=(it.summaries||[])[0]||{}; map[it.asin]={title:s.itemName||null,brand:s.brand||null}; }
    await sleep(600);
  }
  return map;
}

// Report + Daten schreiben; bestehenden Report gleicher Periode ersetzen (wie Upload-Seite).
// Reihenfolge "erst einfügen, dann löschen": vra_reports hat UNIQUE(client_id,period_start,period_end), daher wird eine
// vorhandene Report-Zeile wiederverwendet. Neue vra_data-Zeilen werden zuerst eingefügt, die ALTEN (vorab gelesenen) IDs
// erst danach gelöscht. Schlägt das Einfügen fehl, werden nur die neuen Zeilen zurückgerollt — der alte Stand bleibt.
const sbJson={...sbHead,'Content-Type':'application/json'};
async function sbOk(r,what){ if(!r.ok) throw new Error(`${what}: ${r.status} ${await r.text()}`); return r; }
async function dataIds(reportId){ const ids=[];
  for(let from=0;;){ const rows=await (await sbOk(await fetch(`${U}/rest/v1/vra_data?report_id=eq.${reportId}&select=id&order=id.asc&limit=1000&offset=${from}`,{headers:sbHead}),'vra_data lesen')).json();
    if(!rows.length) break; ids.push(...rows.map(x=>x.id)); from+=rows.length; } // bis zur leeren Seite (unabhängig vom Server-max-rows)
  return ids; }
async function deleteDataIds(ids){ for(let i=0;i<ids.length;i+=50) await sbOk(await fetch(`${U}/rest/v1/vra_data?id=in.(${ids.slice(i,i+50).join(',')})`,{method:'DELETE',headers:sbHead}),'vra_data löschen'); }
async function countData(reportId){ const r=await sbOk(await fetch(`${U}/rest/v1/vra_data?report_id=eq.${reportId}&select=id&limit=1`,{headers:{...sbHead,Prefer:'count=exact'}}),'vra_data zählen'); return +(r.headers.get('content-range')||'').split('/')[1]; }
async function writeReport(client,periodStart,periodEnd,currency,agg,names){
  if(!Object.keys(agg).length) return 0; // nichts zu schreiben — vorhandene Daten nicht durch "leer" ersetzen
  const exRows=await (await sbOk(await fetch(`${U}/rest/v1/vra_reports?client_id=eq.${client.id}&period_start=eq.${periodStart}&select=id&order=id.asc`,{headers:sbHead}),'vra_reports lesen')).json();
  const keep=exRows[0]||null, extras=exRows.slice(1);
  const oldIds=keep?await dataIds(keep.id):[]; // nur diese werden nach erfolgreichem Insert gelöscht
  let reportId;
  if(keep) reportId=keep.id;
  else { const rep=(await (await sbOk(await fetch(`${U}/rest/v1/vra_reports`,{method:'POST',headers:{...sbJson,Prefer:'return=representation'},body:JSON.stringify({client_id:client.id,period_start:periodStart,period_end:periodEnd,currency})}),'vra_reports insert')).json())[0];
    if(!rep) throw new Error('vra_reports insert: leere Antwort'); reportId=rep.id; }
  const rows=Object.entries(agg).map(([asin,v])=>({report_id:reportId,client_id:client.id,asin,
    title:(names[asin]||{}).title||null,brand:(names[asin]||{}).brand||null,
    ordered_revenue:Math.round(v.ordered_revenue*100)/100,ordered_units:v.ordered_units,
    shipped_revenue:Math.round(v.shipped_revenue*100)/100,shipped_cogs:Math.round(v.shipped_cogs*100)/100,
    shipped_units:v.shipped_units,customer_returns:v.customer_returns,
    period_start:periodStart,period_end:periodEnd}));
  const newIds=[];
  try{
    for(let i=0;i<rows.length;i+=500){
      const r=await sbOk(await fetch(`${U}/rest/v1/vra_data?select=id`,{method:'POST',headers:{...sbJson,Prefer:'return=representation'},body:JSON.stringify(rows.slice(i,i+500))}),'vra_data insert');
      newIds.push(...(await r.json()).map(x=>x.id));
    }
  }catch(e){ // Rollback: nur die NEUEN Zeilen (bei neuem Report: Report + alle seine Zeilen); der alte Stand bleibt unberührt
    try{
      if(keep) await deleteDataIds(newIds);
      else { await sbOk(await fetch(`${U}/rest/v1/vra_data?report_id=eq.${reportId}`,{method:'DELETE',headers:sbHead}),'rollback vra_data');
             await sbOk(await fetch(`${U}/rest/v1/vra_reports?id=eq.${reportId}`,{method:'DELETE',headers:sbHead}),'rollback vra_reports'); }
    }catch(e2){ console.log(`    Rollback fehlgeschlagen: ${e2.message}`); }
    throw e; }
  if(keep){ // erst jetzt Altes entfernen: Doppel-Reports gleicher Periode, Report-Zeile aktualisieren, alte Datenzeilen (nur vorab gelesene IDs)
    for(const x of extras){
      await sbOk(await fetch(`${U}/rest/v1/vra_data?report_id=eq.${x.id}`,{method:'DELETE',headers:sbHead}),'vra_data löschen (Doppel-Report)');
      await sbOk(await fetch(`${U}/rest/v1/vra_reports?id=eq.${x.id}`,{method:'DELETE',headers:sbHead}),'vra_reports löschen (Doppel-Report)');
    }
    const upd=await (await sbOk(await fetch(`${U}/rest/v1/vra_reports?id=eq.${keep.id}&select=id`,{method:'PATCH',headers:{...sbJson,Prefer:'return=representation'},body:JSON.stringify({period_end:periodEnd,currency,uploaded_at:new Date().toISOString()})}),'vra_reports update')).json();
    if(upd.length!==1) throw new Error(`vra_reports update: ${upd.length} Zeilen statt 1`); // 0 = stiller No-op (Report zwischenzeitlich gelöscht)
    await deleteDataIds(oldIds);
    const n=await countData(keep.id); // Kontrolle: nur noch die neuen Zeilen übrig? (sonst Duplikate/Reste → Alarm; nächster Lauf bereinigt)
    if(n!==rows.length) throw new Error(`vra_data nach Ersetzen: ${n} Zeilen statt ${rows.length}`);
  }
  return rows.length;
}

const monthEnd=m=>{const d=new Date(m+'T00:00:00Z');return iso(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)));};
// Komplette Monate rückwirkend: bis SINCE (YYYY-MM) oder NMONTHS Stück
function lastMonths(n){ const now=new Date(); const out=[];
  for(let i=1;i<=600;i++){ const m=iso(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1)));
    if(SINCE){ if(m.slice(0,7)<SINCE) break; } else if(i>n) break;
    out.push(m); } return out.reverse(); }

const cr=await fetch(`${U}/rest/v1/vra_clients?spid=not.is.null&auto_sync=eq.true&select=id,name,marketplace,spid`,{headers:sbHead});
let clients=await cr.json();
if(ONLY) clients=clients.filter(c=>c.name.toLowerCase().includes(ONLY));
console.log(`${clients.length} Vendor-Kunde(n) mit API-Verbindung.`);

let failed=0;
async function syncClient(client){
  console.log(`\n== ${client.name} (${client.spid}, ${client.marketplace}) ==`);
  const mkt=MKT_BY_CC[client.marketplace]||MKT_BY_CC.DE;
  const at=await accessToken(client.spid);
  if(!at){console.log('  Kein Refresh-Token — übersprungen.');return;}
  const api=makeApi({'x-amz-access-token':at});

  // Als vollständig gilt nur ein Report, dessen period_end das Monatsende erreicht — ein Teilmonat (laufender Monat,
  // period_end = letzter verfügbarer Tag) wird nach dem Monatswechsel als kompletter Monat neu gezogen und ersetzt.
  const exR=await sbOk(await fetch(`${U}/rest/v1/vra_reports?client_id=eq.${client.id}&select=period_start,period_end`,{headers:sbHead}),'vra_reports lesen');
  const existing=new Set((await exR.json()).filter(r=>r.period_end>=monthEnd(r.period_start)).map(r=>r.period_start));
  const availEnd=iso(new Date(Date.now()-4*86400_000)); // Retail-Analytics-Latenz 48–72h: letzter vollständig verfügbarer Tag

  // 1) Fehlende bzw. noch unvollständige komplette Monate
  for(const m of lastMonths(NMONTHS)){
    if(existing.has(m)){continue;}
    if(monthEnd(m)>availEnd){continue;} // Monatsende noch nicht abrufbar → vorhandener Teilmonat bleibt, bis die Daten komplett sind
    const rows=await fetchVendorSales(api,mkt,'MONTH',m,monthEnd(m));
    if(rows===null){console.log(`  ${m}: Report fehlgeschlagen — übersprungen.`);continue;}
    if(!rows.length){console.log(`  ${m}: keine Daten.`);continue;}
    const agg=aggregate(rows);
    const names=await titleMap(api,client.id,mkt,Object.keys(agg));
    const n=await writeReport(client,m,monthEnd(m),cur(rows),agg,names);
    console.log(`  ${m}: ${n} ASINs importiert.`);
    await sleep(10000); // Reports-API-Quota schonen
  }

  // 2) Laufender Monat (Teilmonat, wird ersetzt). Retail Analytics hat 48–72h
  // Datenlatenz (→ nur bis heute−4 Tage) und DAY-Reports max. ~14 Tage Spanne
  // (→ in 14-Tage-Häppchen ziehen und zusammensetzen).
  const now=new Date();
  const curStart=iso(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)));
  const lastAvail=iso(new Date(Date.now()-4*86400_000));
  if(lastAvail>=curStart){
    let rows=[], ok=true, s=curStart;
    while(s<=lastAvail){
      const sd=new Date(s+'T00:00:00Z');
      const e=new Date(sd); e.setUTCDate(sd.getUTCDate()+13);
      const chunkEnd=iso(e)<lastAvail?iso(e):lastAvail;
      const part=await fetchVendorSales(api,mkt,'DAY',s,chunkEnd);
      if(part===null){ ok=false; break; }
      rows.push(...part);
      const nx=new Date(chunkEnd+'T00:00:00Z'); nx.setUTCDate(nx.getUTCDate()+1); s=iso(nx);
      await sleep(3000);
    }
    if(ok&&rows.length){
      const agg=aggregate(rows);
      const maxEnd=Object.values(agg).reduce((s2,v)=>v.maxEnd&&v.maxEnd>s2?v.maxEnd:s2,curStart);
      const names=await titleMap(api,client.id,mkt,Object.keys(agg));
      const n=await writeReport(client,curStart,maxEnd,cur(rows),agg,names);
      console.log(`  ${curStart} (laufend, bis ${maxEnd}): ${n} ASINs.`);
    } else console.log(`  Laufender Monat: ${ok?'keine Daten':'Report fehlgeschlagen'}.`);
  }
}
// Ein Kunde mit Fehler darf die übrigen nicht abbrechen; am Ende trotzdem Exit 1 (→ Slack-Alert)
for(const client of clients){
  try{ await syncClient(client); }
  catch(e){ failed++; console.log(`  FEHLER bei ${client.name}: ${(e.cause&&e.cause.code)||e.message}`); if(!(e.cause&&e.cause.code)) console.log(e.stack); }
}
console.log('\nFertig.');
if(failed){ console.log(`${failed} Kunde(n) mit Fehler.`); process.exit(1); }
