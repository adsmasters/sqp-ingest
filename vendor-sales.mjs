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
const iso=d=>d.toISOString().slice(0,10);

async function accessToken(spid){
  const r=await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${encodeURIComponent(spid)}&select=refresh_token`,{headers:sbHead});
  const rows=await r.json(); if(!rows[0]) return null;
  const t=await fetch('https://api.amazon.co.uk/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:rows[0].refresh_token,client_id:CID,client_secret:SEC})});
  return (await t.json()).access_token;
}
function makeApi(H){ return async function api(path,opts={},retries=10){
  for(let i=0;i<retries;i++){ const r=await fetch(`${SPAPI}${path}`,{...opts,headers:{...H,...(opts.headers||{})}});
    if(r.status===429){await sleep(25000+Math.random()*10000);continue;} return r; } return null; }; }
async function pollDoc(api,id){ for(let i=0;i<120;i++){await sleep(5000);const g=await api(`/reports/2021-06-30/reports/${id}`);if(!g)return null;const gj=await g.json();if(gj.processingStatus==='DONE')return gj.reportDocumentId;if(['FATAL','CANCELLED'].includes(gj.processingStatus))return null;} return null; }
async function download(api,docId){ const dr=await api(`/reports/2021-06-30/documents/${docId}`);const drj=await dr.json();if(!drj.url)return null;const raw=await fetch(drj.url);let buf=Buffer.from(await raw.arrayBuffer());if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);return JSON.parse(buf.toString('utf8')); }

// Vendor-Sales-Report anfordern und salesByAsin zurückgeben (FATAL → null, z. B. keine Daten im Zeitraum)
async function fetchVendorSales(api,mkt,period,start,end){
  const body={reportType:'GET_VENDOR_SALES_REPORT',marketplaceIds:[mkt],
    dataStartTime:start+'T00:00:00Z',dataEndTime:end+'T23:59:59Z',
    reportOptions:{reportPeriod:period,distributorView:'MANUFACTURING',sellingProgram:'RETAIL'}};
  const c=await api('/reports/2021-06-30/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!c||c.status>=400){console.log(`    createReport ${c?c.status:'-'}: ${c?await c.text():''}`);return null;}
  const docId=await pollDoc(api,(await c.json()).reportId);
  if(!docId) return null;
  const doc=await download(api,docId);
  return doc&&Array.isArray(doc.salesByAsin)?doc.salesByAsin:[];
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

// Report + Daten schreiben; bestehenden Report gleicher Periode ersetzen (wie Upload-Seite)
async function writeReport(client,periodStart,periodEnd,currency,agg,names){
  const ex=await fetch(`${U}/rest/v1/vra_reports?client_id=eq.${client.id}&period_start=eq.${periodStart}&select=id`,{headers:sbHead});
  const exRows=ex.ok?await ex.json():[];
  for(const r of exRows){
    await fetch(`${U}/rest/v1/vra_data?report_id=eq.${r.id}`,{method:'DELETE',headers:sbHead});
    await fetch(`${U}/rest/v1/vra_reports?id=eq.${r.id}`,{method:'DELETE',headers:sbHead});
  }
  const ins=await fetch(`${U}/rest/v1/vra_reports`,{method:'POST',headers:{...sbHead,'Content-Type':'application/json',Prefer:'return=representation'},
    body:JSON.stringify({client_id:client.id,period_start:periodStart,period_end:periodEnd,currency})});
  const rep=(await ins.json())[0];
  const rows=Object.entries(agg).map(([asin,v])=>({report_id:rep.id,client_id:client.id,asin,
    title:(names[asin]||{}).title||null,brand:(names[asin]||{}).brand||null,
    ordered_revenue:Math.round(v.ordered_revenue*100)/100,ordered_units:v.ordered_units,
    shipped_revenue:Math.round(v.shipped_revenue*100)/100,shipped_cogs:Math.round(v.shipped_cogs*100)/100,
    shipped_units:v.shipped_units,customer_returns:v.customer_returns,
    period_start:periodStart,period_end:periodEnd}));
  for(let i=0;i<rows.length;i+=500){
    const r=await fetch(`${U}/rest/v1/vra_data`,{method:'POST',headers:{...sbHead,'Content-Type':'application/json'},body:JSON.stringify(rows.slice(i,i+500))});
    if(!r.ok) throw new Error('vra_data insert: '+r.status+' '+await r.text());
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

for(const client of clients){
  console.log(`\n== ${client.name} (${client.spid}, ${client.marketplace}) ==`);
  const mkt=MKT_BY_CC[client.marketplace]||MKT_BY_CC.DE;
  const at=await accessToken(client.spid);
  if(!at){console.log('  Kein Refresh-Token — übersprungen.');continue;}
  const api=makeApi({'x-amz-access-token':at});

  const exR=await fetch(`${U}/rest/v1/vra_reports?client_id=eq.${client.id}&select=period_start,period_end`,{headers:sbHead});
  const existing=new Set((exR.ok?await exR.json():[]).map(r=>r.period_start));

  // 1) Fehlende komplette Monate
  for(const m of lastMonths(NMONTHS)){
    if(existing.has(m)){continue;}
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
  // Datenlatenz — deshalb nur bis heute−4 Tage anfordern, sonst FATAL.
  const now=new Date();
  const curStart=iso(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)));
  const lastAvail=iso(new Date(Date.now()-4*86400_000));
  if(lastAvail>=curStart){
    const rows=await fetchVendorSales(api,mkt,'DAY',curStart,lastAvail);
    if(rows&&rows.length){
      const agg=aggregate(rows);
      const maxEnd=Object.values(agg).reduce((s,v)=>v.maxEnd&&v.maxEnd>s?v.maxEnd:s,curStart);
      const names=await titleMap(api,client.id,mkt,Object.keys(agg));
      const n=await writeReport(client,curStart,maxEnd,cur(rows),agg,names);
      console.log(`  ${curStart} (laufend, bis ${maxEnd}): ${n} ASINs.`);
    } else console.log(`  Laufender Monat: ${rows===null?'Report fehlgeschlagen':'keine Daten'}.`);
  }
}
console.log('\nFertig.');
