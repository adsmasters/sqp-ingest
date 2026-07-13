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
    if(r.status===429){ await sleep(20000+Math.random()*10000); continue; }
    if(r.status===403){ await refreshAuth(); continue; }
    return r;
  }
  return null;
}
async function pollDoc(reportId){
  for(let i=0;i<60;i++){ await sleep(5000);
    const g=await api(`/reports/2021-06-30/reports/${reportId}`); if(!g) return null;
    const gj=await g.json();
    if(gj.processingStatus==='DONE') return gj.reportDocumentId;
    if(['FATAL','CANCELLED'].includes(gj.processingStatus)) return null;
  } return null;
}
async function download(docId){
  const dr=await api(`/reports/2021-06-30/documents/${docId}`); const drj=await dr.json();
  const raw=await fetch(drj.url); let buf=Buffer.from(await raw.arrayBuffer());
  if(drj.compressionAlgorithm==='GZIP') buf=zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}
async function listAsins(){
  const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify({reportType:'GET_MERCHANT_LISTINGS_ALL_DATA',marketplaceIds:[MKT]})});
  const docId=await pollDoc((await c.json()).reportId);
  const dr=await api(`/reports/2021-06-30/documents/${docId}`); const drj=await dr.json();
  const raw=await fetch(drj.url); let buf=Buffer.from(await raw.arrayBuffer());
  if(drj.compressionAlgorithm==='GZIP') buf=zlib.gunzipSync(buf);
  const lines=buf.toString('latin1').split('\n').filter(Boolean);
  const hdr=lines[0].split('\t'); const iA=hdr.findIndex(h=>/asin[\s_]*1/i.test(h)), iS=hdr.findIndex(h=>/status/i.test(h));
  const act=new Set(['active','aktiv','actif','activo','attivo']); // Report-Status ist lokalisiert (DE: "Aktiv")
  let asins=[...new Set(lines.slice(1).map(l=>l.split('\t')).filter(r=>act.has((r[iS]||'').trim().toLowerCase())).map(r=>r[iA]).filter(Boolean))];
  if(!asins.length) asins=[...new Set(lines.slice(1).flatMap(l=>l.split('\t')).filter(a=>/^B0[A-Z0-9]{8}$/.test((a||'').trim())))]; // Fallback: alle Zellen nach ASIN-Muster scannen
  if(!asins.length){ console.error('FEHLER: keine ASINs im Listings-Report gefunden.'); process.exit(1); }
  return asins;
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
})).filter(x=>x.search_query); }
async function hasData(asin,month){
  const r=await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&asin=eq.${asin}&report_period=eq.MONTH&start_date=eq.${month}&select=id`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY,Prefer:'count=exact',Range:'0-0'}});
  const cr=r.headers.get('content-range')||'0-0/0'; return +cr.split('/')[1]>0;
}
async function upsert(rows,asin,month){
  const q=`selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&asin=eq.${asin}&report_period=eq.MONTH&start_date=eq.${month}`;
  await fetch(`${U}/rest/v1/sqp_asin_rows?${q}`,{method:'DELETE',headers:{apikey:KEY,Authorization:'Bearer '+KEY}});
  if(!rows.length) return 0;
  const ins=await fetch(`${U}/rest/v1/sqp_asin_rows`,{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(rows)});
  return ins.ok?rows.length:0;
}
// Create-Gate: serialisiert die Report-Erstellungen mit Mindestabstand (Rate-Limit),
// während Poll/Download parallel laufen dürfen.
const CREATE_GAP=8000; let createGate=Promise.resolve();
async function spacedCreate(body){
  let release; const prev=createGate; createGate=new Promise(r=>release=r);
  await prev;
  const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify(body)},10);
  setTimeout(release,CREATE_GAP);
  return c;
}
async function task(asin,month){
  if(await hasData(asin,month)) return `skip ${month} ${asin} (schon da)`;
  const body={reportType:'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',marketplaceIds:[MKT],dataStartTime:month+'T00:00:00Z',dataEndTime:monthEnd(month)+'T00:00:00Z',reportOptions:{reportPeriod:'MONTH',asin}};
  const c=await spacedCreate(body);
  if(!c) return `FAIL create ${month} ${asin}`;
  const cj=await c.json(); if(!cj.reportId) return `ERR ${month} ${asin}: ${JSON.stringify(cj).slice(0,120)}`;
  const docId=await pollDoc(cj.reportId); if(!docId) return `FATAL ${month} ${asin}`;
  const n=await upsert(mapRows(await download(docId),asin),asin,month);
  return `ok ${month} ${asin}: ${n}`;
}
async function pool(tasks,conc){
  let i=0,done=0; const runners=Array.from({length:conc},async()=>{
    while(i<tasks.length){ const idx=i++; const [asin,month]=tasks[idx];
      try{ const msg=await task(asin,month); done++; console.log(`[${done}/${tasks.length}] ${msg}`); }
      catch(e){ done++; console.log(`[${done}/${tasks.length}] EXC ${month} ${asin}: ${e.message}`); } } });
  await Promise.all(runners);
}
async function main(){
  await refreshAuth();
  const asins=await listAsins(); const ms=months(startM,endM);
  const tasks=[]; for(const m of ms) for(const a of asins) tasks.push([a,m]);
  console.log(`Backfill ${startM}..${endM}: ${ms.length} Monate × ${asins.length} ASINs = ${tasks.length} Tasks, Concurrency ${CONC}`);
  const t0=Date.now();
  await pool(tasks,CONC);
  console.log(`FERTIG in ${Math.round((Date.now()-t0)/60000)} Min.`);
}
main().catch(e=>{console.error('FEHLER',e);process.exit(1);});
