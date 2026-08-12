// SQP-Backfill (parallel + resumierbar): zieht SQP je ASIN & Monat für einen Monatsbereich.
// Läuft mit Concurrency-Pool, überspringt bereits vorhandene (asin,month) → jederzeit neu startbar.
// Aufruf: node sqp-backfill.mjs <startMonth YYYY-MM-01> <endMonth YYYY-MM-01> [concurrency=4]
// ENV: SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
import zlib from 'node:zlib';
import fs from 'node:fs';
// .env-Fallback (verhindert ERR_INVALID_URL bei Starts ohne Export)
try{ const e=Object.fromEntries(fs.readFileSync(new URL('.env',import.meta.url),'utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()];})); for(const k in e) if(!process.env[k]) process.env[k]=e[k]; }catch{}
const CID=process.env.SPAPI_CLIENT_ID, SEC=process.env.SPAPI_CLIENT_SECRET;
const U=process.env.SUPABASE_URL, KEY=process.env.SUPABASE_SERVICE_KEY;
if(!U||!KEY||!CID||!SEC){ console.error('FEHLER: fehlende ENV.'); process.exit(1); }
// Kunde per ENV wählbar (Default: RECOACTIV DE)
const SPID=process.env.SQP_SPID||'AB0SPXUYQ1F1W', MKT=process.env.SQP_MKT||'A1PA6795UKMFR9', SPAPI='https://sellingpartnerapi-eu.amazon.com';
console.log(`Kunde: SPID=${SPID} MKT=${MKT}`);
const startM=process.argv[2]||'2025-07-01', endM=process.argv[3]||'2026-06-01';
const CONC=+(process.argv[4]||4);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function months(a,b){ const out=[]; let d=new Date(a+'T00:00:00Z'); const e=new Date(b+'T00:00:00Z');
  while(d<=e){ out.push(d.toISOString().slice(0,10)); d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)); } return out; }
function monthEnd(m){ const d=new Date(m+'T00:00:00Z'); return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10); }

let AT,H;
async function refreshAuth(){
  const r=await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${SPID}&select=refresh_token`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY}});
  const [{refresh_token}]=await r.json();
  const t=await fetch('https://api.amazon.co.uk/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token,client_id:CID,client_secret:SEC})});
  AT=(await t.json()).access_token; H={'x-amz-access-token':AT,'Content-Type':'application/json'};
}
async function api(path,opts={},retries=6){
  for(let i=0;i<retries;i++){
    let r;
    try{ r=await fetch(`${SPAPI}${path}`,{...opts,headers:{...H,...(opts.headers||{})}}); }
    catch(e){ await sleep(5000+Math.random()*10000); continue; } // transienter Netzfehler
    // 429: Wartezeit waechst mit — das Create-Kontingent fuellt sich nur ~1/Min auf,
    // feste 25s liefen ins Leere und ALLE Lanes endeten in "FAIL create" (12.08.)
    if(r.status===429){ await sleep(Math.min(90000,15000+i*15000)+Math.random()*10000); continue; }
    if(r.status===403){ await refreshAuth(); continue; }
    return r;
  }
  return null;
}
async function pollDoc(reportId){
  // 30 Min: Multi-ASIN-Reports stehen deutlich laenger IN_QUEUE als Einzel-Reports
  for(let i=0;i<360;i++){ await sleep(5000);
    const g=await api(`/reports/2021-06-30/reports/${reportId}`); if(!g) return null;
    if(g.status===400||g.status===404) return {gone:true}; // adoptierter Report existiert nicht mehr
    const gj=await g.json();
    if(gj.processingStatus==='DONE') return {docId:gj.reportDocumentId};
    if(['FATAL','CANCELLED'].includes(gj.processingStatus)) return {fatal:true};
  } return {timeout:true};
}
async function download(docId){
  const dr=await api(`/reports/2021-06-30/documents/${docId}`); const drj=await dr.json();
  const raw=await fetch(drj.url); let buf=Buffer.from(await raw.arrayBuffer());
  if(drj.compressionAlgorithm==='GZIP') buf=zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}
async function listAsins(){
  const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify({reportType:'GET_MERCHANT_LISTINGS_ALL_DATA',marketplaceIds:[MKT]})});
  const docId=((await pollDoc((await c.json()).reportId))||{}).docId;
  if(!docId){ console.error('FEHLER: Listings-Report nicht fertig (FATAL/Timeout) — Teillauf.'); process.exit(1); }
  const dr=await api(`/reports/2021-06-30/documents/${docId}`); const drj=dr?await dr.json():null;
  if(!drj||!drj.url){ console.error('FEHLER: Listings-Report-Dokument ohne URL — Teillauf.'); process.exit(1); }
  const raw=await fetch(drj.url); let buf=Buffer.from(await raw.arrayBuffer());
  if(drj.compressionAlgorithm==='GZIP') buf=zlib.gunzipSync(buf);
  const lines=buf.toString('latin1').split('\n').filter(Boolean);
  const hdr=lines[0].split('\t'); const iA=hdr.findIndex(h=>/asin[\s_]*1/i.test(h)), iS=hdr.findIndex(h=>/status/i.test(h));
  const act=new Set(['active','aktiv','actif','activo','attivo']); // Report-Status ist lokalisiert (DE: "Aktiv")
  let asins=[...new Set(lines.slice(1).map(l=>l.split('\t')).filter(r=>act.has((r[iS]||'').trim().toLowerCase())).map(r=>r[iA]).filter(Boolean))];
  if(!asins.length) asins=[...new Set(lines.slice(1).flatMap(l=>l.split('\t')).filter(a=>/^B0[A-Z0-9]{8}$/.test((a||'').trim())))]; // Fallback: alle Zellen nach ASIN-Muster scannen
  if(!asins.length){ console.error('FEHLER: keine ASINs im Listings-Report gefunden.'); process.exit(1); }
  return applyBrandFilter(asins);
}
// Marken-Filter: Union der brand_filter aller aktiven Kunden dieses Sellers (sqp_clients).
// Kein Filter bei irgendeinem Kunden = alle Marken. Fallback auf alle, wenn Marken-Infos fehlen.
async function applyBrandFilter(asins){
  const hd={apikey:KEY,Authorization:'Bearer '+KEY};
  const cr=await fetch(`${U}/rest/v1/sqp_clients?spid=eq.${SPID}&active=eq.true&select=brand_filter`,{headers:hd});
  const cl=cr.ok?await cr.json():[];
  if(!cl.length||cl.some(c=>!c.brand_filter||!c.brand_filter.length)) return asins;
  const want=new Set(cl.flatMap(c=>c.brand_filter));
  const mr=await fetch(`${U}/rest/v1/sqp_asin_meta?spid=eq.${SPID}&brand=not.is.null&select=asin,brand&limit=10000`,{headers:{...hd,Range:'0-9999'}});
  const meta=mr.ok?await mr.json():[];
  if(!meta.length){ console.log('WARNUNG: Marken-Filter gesetzt, aber keine Marken in sqp_asin_meta — importiere ALLE ASINs.'); return asins; }
  const byAsin=new Map(meta.map(m=>[m.asin,m.brand]));
  const keep=asins.filter(a=>want.has(byAsin.get(a)));
  if(!keep.length){ console.log('WARNUNG: Marken-Filter matcht 0 ASINs — importiere ALLE ASINs.'); return asins; }
  console.log(`Marken-Filter aktiv [${[...want].join(', ')}]: ${keep.length} von ${asins.length} ASINs.`);
  return keep;
}
// Umsatz-Priorisierung + optionale Kappung: verkaufsstärkste ASINs zuerst (30-Tage-Umsatz
// aus asin_sales_traffic). Standard-Kappung Top 50 bei grossen Katalogen — Job-Notiz
// 'alle-asins' importiert alles, 'topN' (z.B. top300) ändert das Limit. OHNE Umsatzdaten
// wird NIE gekappt (sonst wäre die Top-Auswahl zufällig).
const MKT_CC={A1PA6795UKMFR9:'DE',A13V1IB3VIYZZH:'FR',APJ6JRA9NG5V4:'IT',A1RKKUPIHCS9HS:'ES',A1F83G8C2ARO7P:'UK',ATVPDKIKX0DER:'US',A1805IZSGTT6HS:'NL',A2NODRKZP88ZB9:'SE',A1C3SOZRARQ6R3:'PL',A33AVAJ2PDY3EV:'TR',AMEN7PMS3EDWL:'BE',A17E79C6D8DWNP:'SA',A2VIGQ35RCS4UG:'AE'};
async function rankAndCap(asins){
  const note=process.env.SQP_JOB_NOTE||'';
  const cc=MKT_CC[MKT]||'DE';
  const sales=new Map();
  try{
    const r=await fetch(`${U}/rest/v1/asin_sales_traffic?spid=eq.${SPID}&days=eq.30&marketplace=eq.${cc}&select=asin,sales`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY,Range:'0-4999'}});
    if(r.ok) for(const x of await r.json()) sales.set(x.asin,+x.sales||0);
  }catch(e){}
  const ranked=[...asins].sort((a,b)=>(sales.get(b)||0)-(sales.get(a)||0));
  if(sales.size) console.log(`Priorisierung: verkaufsstärkste zuerst (Umsatzdaten für ${sales.size} ASINs, ${cc}).`);
  // Manuell angeforderte ASINs (asin_focus am Kunden) laufen IMMER mit — vom Team im Tool eingetragen
  let focus=[];
  try{
    const fr=await fetch(`${U}/rest/v1/sqp_clients?spid=eq.${SPID}&active=eq.true&marketplace=eq.${cc}&select=asin_focus`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY}});
    if(fr.ok) focus=[...new Set((await fr.json()).flatMap(c=>c.asin_focus||[]))].filter(a=>/^B0[A-Z0-9]{8}$/i.test(a)).map(a=>a.toUpperCase());
  }catch(e){}
  const withFocus=list=>{ const set=new Set(list); const extra=focus.filter(a=>!set.has(a)); if(extra.length) console.log(`+ ${extra.length} manuell angeforderte Fokus-ASINs.`); return [...extra,...list]; };
  const mTop=note.match(/top\s*(\d+)/i);
  const cap=mTop?+mTop[1]:50;
  if(/alle-asins/i.test(note)||ranked.length<=cap) return withFocus(ranked);
  if(!sales.size){ console.log(`Kein Umsatz-Ranking für ${cc} verfügbar — KEINE Kappung, alle ${ranked.length} ASINs.`); return withFocus(ranked); }
  console.log(`Kappung: Top ${cap} von ${ranked.length} ASINs nach 30-Tage-Umsatz (Job-Notiz 'alle-asins' = alles, 'top<N>' = anderes Limit).`);
  return withFocus(ranked.slice(0,cap));
}
// Leer-Vermerke: Perioden, die Amazon geprüft aber ohne (relevante) Daten beantwortet hat —
// werden sonst in JEDEM Teillauf erneut angefragt (Riesen-Kataloge: Tausende Anfragen pro Nacht umsonst)
const EMPTY=new Set();
async function loadEmpty(){
  for(let from=0;;from+=1000){
    const r=await fetch(`${U}/rest/v1/sqp_empty_periods?spid=eq.${SPID}&marketplace_id=eq.${MKT}&report_period=eq.MONTH&select=asin,start_date`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY,Range:`${from}-${from+999}`}});
    if(!r.ok) break;
    const rows=await r.json();
    for(const x of rows) EMPTY.add(x.asin+'|'+x.start_date);
    if(rows.length<1000) break;
  }
  if(EMPTY.size) console.log(`${EMPTY.size} bekannte Leer-Perioden werden übersprungen.`);
}
async function markEmpty(asin,month){
  try{ await fetch(`${U}/rest/v1/sqp_empty_periods?on_conflict=spid,marketplace_id,asin,report_period,start_date`,{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({spid:SPID,marketplace_id:MKT,asin,report_period:'MONTH',start_date:month})}); }catch(e){}
  EMPTY.add(asin+'|'+month);
}
const num=x=>(x&&typeof x==='object'&&'amount'in x)?x.amount:x;
function mapRows(data,asin){ return (data.dataByAsin||[]).map(r=>({
  selling_partner_id:SPID,marketplace_id:MKT,asin,report_period:'MONTH',start_date:r.startDate,end_date:r.endDate,
  search_query:r.searchQueryData?.searchQuery,search_query_score:r.searchQueryData?.searchQueryScore,search_query_volume:r.searchQueryData?.searchQueryVolume,
  total_query_impression_count:r.impressionData?.totalQueryImpressionCount,asin_impression_count:r.impressionData?.asinImpressionCount,asin_impression_share:r.impressionData?.asinImpressionShare,
  total_click_count:r.clickData?.totalClickCount,asin_click_count:r.clickData?.asinClickCount,asin_click_share:r.clickData?.asinClickShare,
  total_cart_add_count:r.cartAddData?.totalCartAddCount,asin_cart_add_count:r.cartAddData?.asinCartAddCount,asin_cart_add_share:r.cartAddData?.asinCartAddShare,
  total_purchase_count:r.purchaseData?.totalPurchaseCount,asin_purchase_count:r.purchaseData?.asinPurchaseCount,asin_purchase_share:r.purchaseData?.asinPurchaseShare,
  asin_median_purchase_price:num(r.purchaseData?.asinMedianPurchasePrice),
})).filter(x=>x.search_query&&(+x.search_query_volume||0)>=50); } // Mini-Volumen raus
async function hasData(asin,month){
  const r=await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&asin=eq.${asin}&report_period=eq.MONTH&start_date=eq.${month}&select=id`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY,Prefer:'count=exact',Range:'0-0'}});
  const cr=r.headers.get('content-range')||'0-0/0'; return +cr.split('/')[1]>0;
}
async function upsert(rows,asin,month){
  const q=`selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&asin=eq.${asin}&report_period=eq.MONTH&start_date=eq.${month}`;
  await fetch(`${U}/rest/v1/sqp_asin_rows?${q}`,{method:'DELETE',headers:{apikey:KEY,Authorization:'Bearer '+KEY}});
  if(!rows.length) return 0;
  const ins=await fetch(`${U}/rest/v1/sqp_asin_rows`,{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(rows)});
  return ins.ok?rows.length:-1; // -1 = Insert-Fehler, NICHT als "leer" vermerken
}
// Create-Gate: serialisiert die Report-Erstellungen mit Mindestabstand (Rate-Limit),
// während Poll/Download parallel laufen dürfen.
const CREATE_GAP=+(process.env.SQP_CREATE_GAP||8000); let createGate=Promise.resolve();
async function spacedCreate(body){
  let release; const prev=createGate; createGate=new Promise(r=>release=r);
  await prev;
  const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify(body)},10);
  setTimeout(release,CREATE_GAP);
  return c;
}
// ASIN-Batching: Amazon erlaubt eine leerzeichengetrennte ASIN-Liste je Report
// (max 200 Zeichen -> 18 ASINs; live verifiziert 11.08.: Zeilen tragen ihr eigenes
// asin-Feld). 18x weniger Reports = Onboarding in Minuten statt Stunden.
// Achtung: Multi-ASIN-Reports stehen laenger IN_QUEUE (~10 Min) — pollDoc ist darauf ausgelegt.
const BATCH=18;
// Report-Registry: bestellte Reports überleben das Zeitscheiben-Ende. Amazon arbeitet
// sie weiter ab; der nächste Lauf ADOPTIERT sie statt neu zu bestellen — vorher wurde
// dasselbe Kontingent jede Runde erneut verbrannt und die Queue verstopfte (12.08.).
const REG_HD={apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'};
async function regGet(period,key){
  try{ const r=await fetch(`${U}/rest/v1/sqp_report_registry?spid=eq.${SPID}&marketplace_id=eq.${MKT}&report_period=eq.MONTH&start_date=eq.${period}&asin_key=eq.${encodeURIComponent(key)}&created_at=gt.${new Date(Date.now()-24*3600e3).toISOString()}&select=report_id`,{headers:REG_HD});
    const j=r.ok?await r.json():[]; return j[0]&&j[0].report_id; }catch(e){ return null; }
}
async function regPut(period,key,reportId){
  try{ await fetch(`${U}/rest/v1/sqp_report_registry?on_conflict=spid,marketplace_id,report_period,start_date,asin_key`,{method:'POST',headers:{...REG_HD,Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({spid:SPID,marketplace_id:MKT,report_period:'MONTH',start_date:period,asin_key:key,report_id:reportId,created_at:new Date().toISOString()})}); }catch(e){}
}
async function regDel(period,key){
  try{ await fetch(`${U}/rest/v1/sqp_report_registry?spid=eq.${SPID}&marketplace_id=eq.${MKT}&report_period=eq.MONTH&start_date=eq.${period}&asin_key=eq.${encodeURIComponent(key)}`,{method:'DELETE',headers:REG_HD}); }catch(e){}
}
async function task(batch,month){
  const regKey=batch.join(' ');
  let reportId=await regGet(month,regKey);
  if(!reportId){
    const body={reportType:'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',marketplaceIds:[MKT],dataStartTime:month+'T00:00:00Z',dataEndTime:monthEnd(month)+'T00:00:00Z',reportOptions:{reportPeriod:'MONTH',asin:regKey}};
    const c=await spacedCreate(body);
    if(!c) return `FAIL create ${month} [${batch.length} ASINs]`;
    const cj=await c.json(); if(!cj.reportId) return `ERR ${month} [${batch.length} ASINs]: ${JSON.stringify(cj).slice(0,120)}`;
    reportId=cj.reportId; await regPut(month,regKey,reportId);
  }
  const pd=await pollDoc(reportId);
  if(pd&&pd.gone){ await regDel(month,regKey); return task(batch,month); }
  if(!pd||pd.timeout) return `TIMEOUT ${month} [${batch.length} ASINs] (Report vorgemerkt — nächster Lauf übernimmt ihn)`;
  await regDel(month,regKey); // Report ist entschieden (DONE/FATAL) — Vormerkung aufheben
  if(pd.fatal){
    // Amazon meldet FATAL, wenn es fuer die Anfrage KEINE Daten gibt. Batch einmal
    // aufspalten, Einzel-FATAL dauerhaft als leer vermerken — sonst Endlosschleife
    // (die Nachtlaeufe wiederholten dieselben FATALs jede Runde; 11.08.).
    if(batch.length>1){ const out=[]; for(const a of batch) out.push(await task([a],month)); return `split ${month}: ${out.length} einzeln nachgeprüft`; }
    await markEmpty(batch[0],month);
    return `leer ${month} ${batch[0]} (FATAL = keine Daten, vermerkt)`;
  }
  const rows=(await download(pd.docId)).dataByAsin||[];
  if(batch.length>1&&rows.length&&rows[0].asin===undefined){
    // Format-Überraschung: Zeilen ohne eigenes ASIN-Feld -> einzeln nachladen statt falsch zuordnen
    const out=[]; for(const a of batch) out.push(await task([a],month)); return out.join(' | ');
  }
  const byAsin=new Map(batch.map(a=>[a,[]]));
  for(const r of rows){ const a=String(r.asin||batch[0]).toUpperCase(); if(byAsin.has(a)) byAsin.get(a).push(r); }
  let ok=0,leer=0;
  for(const [a,rws] of byAsin){
    const n=await upsert(mapRows({dataByAsin:rws},a),a,month);
    if(n===0){ await markEmpty(a,month); leer++; } else if(n===-1){ UNVOLLSTAENDIG++; } else ok+=n;
  }
  return `ok ${month} [${batch.length} ASINs]: ${ok} Zeilen${leer?`, ${leer} leer vermerkt`:''}`;
}
let UNVOLLSTAENDIG=0; // TIMEOUT/FAIL/ERR-Tasks: Lauf darf NICHT als fertig gelten (sonst Job 'done' ohne Daten — MoleQlar/Femarelle 11.08.)
async function pool(tasks,conc){
  let i=0,done=0; const runners=Array.from({length:conc},async()=>{
    while(i<tasks.length){ const idx=i++; const [batch,month]=tasks[idx];
      try{ const msg=await task(batch,month); done++; console.log(`[${done}/${tasks.length}] ${msg}`); if(/TIMEOUT|FAIL|ERR /.test(msg)) UNVOLLSTAENDIG++; }
      catch(e){ done++; UNVOLLSTAENDIG++; console.log(`[${done}/${tasks.length}] EXC ${month} [${batch.length} ASINs]: ${e.message}`); } } });
  await Promise.all(runners);
}
// Bedarf je (ASIN,Monat) vorab prüfen (8 parallel), dann ASIN-major in 18er-Batches:
// die Top-18-Gruppe zuerst über alle Monate — wichtigste ASINs sind zuerst KOMPLETT.
async function buildTasks(asins,ms){
  const pairs=[]; for(const a of asins) for(const m of ms) pairs.push([a,m]);
  const need=new Set(); let i=0;
  await Promise.all(Array.from({length:8},async()=>{
    while(i<pairs.length){ const idx=i++; const [a,m]=pairs[idx];
      if(EMPTY.has(a+'|'+m)) continue;
      if(!(await hasData(a,m))) need.add(a+'|'+m); } }));
  const tasks=[];
  for(let s=0;s<asins.length;s+=BATCH){ const grp=asins.slice(s,s+BATCH);
    for(const m of ms){ const sub=grp.filter(a=>need.has(a+'|'+m)); if(sub.length) tasks.push([sub,m]); } }
  return tasks;
}
async function main(){
  await refreshAuth();
  const asins=await rankAndCap(await listAsins()); const ms=months(startM,endM);
  await loadEmpty();
  const tasks=await buildTasks(asins,ms);
  const nAsins=tasks.reduce((s,[b])=>s+b.length,0);
  console.log(`Backfill ${startM}..${endM}: ${ms.length} Monate × ${asins.length} ASINs -> ${tasks.length} Batch-Reports (${nAsins} offene ASIN-Perioden), Concurrency ${CONC}`);
  const t0=Date.now();
  await pool(tasks,CONC);
  if(UNVOLLSTAENDIG>0){ console.log(`TEILLAUF: ${UNVOLLSTAENDIG} Task(s) unvollständig (Timeout/Fehler) — nächster Lauf setzt fort.`); process.exit(2); }
  console.log(`FERTIG in ${Math.round((Date.now()-t0)/60000)} Min.`);
}
main().catch(e=>{console.error('FEHLER',e);process.exit(1);});
