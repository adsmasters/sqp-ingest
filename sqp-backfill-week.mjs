// SQP-Wochen-Backfill (parallel, resumierbar). Amazon-SQP-Wochen: Sonntag–Samstag.
// Aufruf: node sqp-backfill-week.mjs [anzahlWochen=12] [concurrency=6]
// ENV: SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
import zlib from 'node:zlib';
import fs from 'node:fs';
// .env als Fallback laden, falls process.env leer ist (verhindert ERR_INVALID_URL bei Neustarts ohne Export)
try{ const e=Object.fromEntries(fs.readFileSync(new URL('.env',import.meta.url),'utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()];})); for(const k in e) if(!process.env[k]) process.env[k]=e[k]; }catch{}
// Aliase: .env nutzt teils CLIENT_ID/CLIENT_SECRET (Ads) — SP-API-Keys separat halten
const CID=process.env.SPAPI_CLIENT_ID||process.env.LWA_CLIENT_ID, SEC=process.env.SPAPI_CLIENT_SECRET||process.env.LWA_CLIENT_SECRET;
const U=process.env.SUPABASE_URL, KEY=process.env.SUPABASE_SERVICE_KEY;
if(!U||!KEY||!CID||!SEC){ console.error('FEHLER: fehlende ENV (SUPABASE_URL/SERVICE_KEY, SPAPI_CLIENT_ID/SECRET). Abbruch.'); process.exit(1); }
const SPID=process.env.SQP_SPID||'AB0SPXUYQ1F1W', MKT=process.env.SQP_MKT||'A1PA6795UKMFR9', SPAPI='https://sellingpartnerapi-eu.amazon.com';
const NWEEKS=+(process.argv[2]||12), CONC=+(process.argv[3]||6);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const iso=d=>d.toISOString().slice(0,10);

// letzte NWEEKS abgeschlossene Wochen (Sonntag-Start), aktuelle (unvollständige) Woche ausgelassen
const LAG_DAYS=+(process.env.SQP_WEEK_LAG_DAYS||6); // SQP-Wochen-Lag: Wochen, deren Samstag < LAG_DAYS her ist, sind noch nicht publiziert -> ueberspringen
function weeks(n){
  const now=new Date();
  const day=now.getUTCDay(); // 0=So
  // Start der aktuellen Woche (Sonntag)
  const curSun=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-day));
  const cutoff=Date.now()-LAG_DAYS*864e5;
  const out=[];
  for(let i=1;i<=n;i++){ const s=new Date(curSun); s.setUTCDate(curSun.getUTCDate()-7*i);
    const sat=new Date(s); sat.setUTCDate(s.getUTCDate()+6);
    if(sat.getTime()>cutoff) continue; // Woche endet zu kurz zurueck -> Daten noch nicht da
    out.push(iso(s)); }
  return out; // neueste zuerst
}
const satOf=sun=>{ const d=new Date(sun+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+6); return iso(d); };

let AT,H;
async function refreshAuth(){
  const r=await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${SPID}&select=refresh_token`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY}});
  const [{refresh_token}]=await r.json();
  const t=await fetch('https://api.amazon.co.uk/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token,client_id:CID,client_secret:SEC})});
  AT=(await t.json()).access_token; H={'x-amz-access-token':AT,'Content-Type':'application/json'};
}
async function api(path,opts={},retries=10){
  for(let i=0;i<retries;i++){
    let r;
    try{ r=await fetch(`${SPAPI}${path}`,{...opts,headers:{...H,...(opts.headers||{})}}); }
    catch(e){ await sleep(5000+Math.random()*10000); continue; } // transienter Netzfehler -> erneut versuchen
    if(r.status===429){ await sleep(25000+Math.random()*10000); continue; }
    if(r.status===403){ await refreshAuth(); continue; }
    return r;
  } return null;
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
async function listAsinsOnce(){
  const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify({reportType:'GET_MERCHANT_LISTINGS_ALL_DATA',marketplaceIds:[MKT]})});
  if(!c) return null; const cj=await c.json(); if(!cj.reportId) return null;
  const docId=await pollDoc(cj.reportId); if(!docId) return null;
  const dr=await api(`/reports/2021-06-30/documents/${docId}`); if(!dr) return null; const drj=await dr.json();
  const raw=await fetch(drj.url); let buf=Buffer.from(await raw.arrayBuffer());
  if(drj.compressionAlgorithm==='GZIP') buf=zlib.gunzipSync(buf);
  const lines=buf.toString('latin1').split('\n').filter(Boolean);
  const hdr=lines[0].split('\t'); const iA=hdr.findIndex(h=>/asin[\s_]*1/i.test(h)), iS=hdr.findIndex(h=>/status/i.test(h));
  const act=new Set(['active','aktiv','actif','activo','attivo']); // Report-Status ist lokalisiert (DE: "Aktiv")
  let asins=[...new Set(lines.slice(1).map(l=>l.split('\t')).filter(r=>act.has((r[iS]||'').trim().toLowerCase())).map(r=>r[iA]).filter(Boolean))];
  if(!asins.length) asins=[...new Set(lines.slice(1).flatMap(l=>l.split('\t')).filter(a=>/^B0[A-Z0-9]{8}$/.test((a||'').trim())))]; // Fallback: alle Zellen nach ASIN-Muster scannen
  return asins;
}
// ASINs bevorzugt aus der DB (neuester Monat -> ~17 Zeilen, kein SP-API-Drossel)
async function listAsinsFromDb(){
  try{
    const H2={apikey:KEY,Authorization:'Bearer '+KEY};
    const lr=await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&report_period=eq.MONTH&select=start_date&order=start_date.desc&limit=1`,{headers:H2});
    if(!lr.ok) return null; const lj=await lr.json(); const latest=lj[0]&&lj[0].start_date; if(!latest) return null;
    const set=new Set();
    for(let from=0;from<40000;from+=1000){
      const r=await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&report_period=eq.MONTH&start_date=eq.${latest}&select=asin`,{headers:{...H2,Range:`${from}-${from+999}`}});
      if(!r.ok) return null; const chunk=await r.json(); chunk.forEach(x=>x.asin&&set.add(x.asin)); if(chunk.length<1000) break;
    }
    return [...set];
  }catch(e){ return null; }
}
async function listAsins(){
  const db=await listAsinsFromDb(); if(db&&db.length){ console.log(`  ${db.length} ASINs aus DB (neuester Monat)`); return applyBrandFilter(db); }
  console.log('  DB leer -> Merchant-Report (Fallback)');
  for(let a=0;a<5;a++){ try{ const r=await listAsinsOnce(); if(r&&r.length) return applyBrandFilter(r); }catch(e){ console.log(`  listAsins Versuch ${a+1}: ${e.message}`); }
    console.log(`  listAsins gedrosselt/leer, warte 40s (Versuch ${a+1}/5)…`); await sleep(40000); }
  throw new Error('listAsins fehlgeschlagen (DB leer + SP-API-Drossel?)');
}
// Marken-Filter (Union der brand_filter aller aktiven Kunden dieses Sellers); Fallback = alle
async function applyBrandFilter(asins){
  const hd={apikey:KEY,Authorization:'Bearer '+KEY};
  const cr=await fetch(`${U}/rest/v1/sqp_clients?spid=eq.${SPID}&active=eq.true&select=brand_filter`,{headers:hd});
  const cl=cr.ok?await cr.json():[];
  if(!cl.length||cl.some(c=>!c.brand_filter||!c.brand_filter.length)) return asins;
  const want=new Set(cl.flatMap(c=>c.brand_filter));
  const mr=await fetch(`${U}/rest/v1/sqp_asin_meta?spid=eq.${SPID}&brand=not.is.null&select=asin,brand&limit=10000`,{headers:{...hd,Range:'0-9999'}});
  const meta=mr.ok?await mr.json():[];
  if(!meta.length){ console.log('WARNUNG: Marken-Filter gesetzt, aber keine Marken in sqp_asin_meta — nehme ALLE ASINs.'); return asins; }
  const byAsin=new Map(meta.map(m=>[m.asin,m.brand]));
  const keep=asins.filter(a=>want.has(byAsin.get(a)));
  if(!keep.length){ console.log('WARNUNG: Marken-Filter matcht 0 ASINs — nehme ALLE ASINs.'); return asins; }
  console.log(`  Marken-Filter aktiv [${[...want].join(', ')}]: ${keep.length} von ${asins.length} ASINs.`);
  return keep;
}
// Umsatz-Priorisierung + optionale Kappung (Details siehe sqp-backfill.mjs — gleiche Logik)
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
  if(sales.size) console.log(`  Priorisierung: verkaufsstärkste zuerst (Umsatzdaten für ${sales.size} ASINs, ${cc}).`);
  const mTop=note.match(/top\s*(\d+)/i);
  const cap=mTop?+mTop[1]:150;
  if(/alle-asins/i.test(note)||ranked.length<=cap) return ranked;
  if(!sales.size){ console.log(`  Kein Umsatz-Ranking für ${cc} — KEINE Kappung, alle ${ranked.length} ASINs.`); return ranked; }
  console.log(`  Kappung: Top ${cap} von ${ranked.length} ASINs nach 30-Tage-Umsatz.`);
  return ranked.slice(0,cap);
}
// Leer-Vermerke (Perioden ohne relevante Daten — nicht jede Nacht erneut anfragen)
const EMPTY=new Set();
async function loadEmpty(){
  for(let from=0;;from+=1000){
    const r=await fetch(`${U}/rest/v1/sqp_empty_periods?spid=eq.${SPID}&marketplace_id=eq.${MKT}&report_period=eq.WEEK&select=asin,start_date`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY,Range:`${from}-${from+999}`}});
    if(!r.ok) break;
    const rows=await r.json();
    for(const x of rows) EMPTY.add(x.asin+'|'+x.start_date);
    if(rows.length<1000) break;
  }
  if(EMPTY.size) console.log(`  ${EMPTY.size} bekannte Leer-Wochen werden übersprungen.`);
}
async function markEmpty(asin,week){
  try{ await fetch(`${U}/rest/v1/sqp_empty_periods?on_conflict=spid,marketplace_id,asin,report_period,start_date`,{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({spid:SPID,marketplace_id:MKT,asin,report_period:'WEEK',start_date:week})}); }catch(e){}
  EMPTY.add(asin+'|'+week);
}
const num=x=>(x&&typeof x==='object'&&'amount'in x)?x.amount:x;
function mapRows(data,asin){ return (data.dataByAsin||[]).map(r=>({
  selling_partner_id:SPID,marketplace_id:MKT,asin,report_period:'WEEK',start_date:r.startDate,end_date:r.endDate,
  search_query:r.searchQueryData?.searchQuery,search_query_score:r.searchQueryData?.searchQueryScore,search_query_volume:r.searchQueryData?.searchQueryVolume,
  total_query_impression_count:r.impressionData?.totalQueryImpressionCount,asin_impression_count:r.impressionData?.asinImpressionCount,asin_impression_share:r.impressionData?.asinImpressionShare,
  total_click_count:r.clickData?.totalClickCount,asin_click_count:r.clickData?.asinClickCount,asin_click_share:r.clickData?.asinClickShare,
  total_cart_add_count:r.cartAddData?.totalCartAddCount,asin_cart_add_count:r.cartAddData?.asinCartAddCount,asin_cart_add_share:r.cartAddData?.asinCartAddShare,
  total_purchase_count:r.purchaseData?.totalPurchaseCount,asin_purchase_count:r.purchaseData?.asinPurchaseCount,asin_purchase_share:r.purchaseData?.asinPurchaseShare,
  asin_median_purchase_price:num(r.purchaseData?.asinMedianPurchasePrice),
})).filter(x=>x.search_query&&(+x.search_query_volume||0)>=10); } // Mini-Volumen raus
async function hasData(asin,week){
  const r=await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&asin=eq.${asin}&report_period=eq.WEEK&start_date=eq.${week}&select=id`,{headers:{apikey:KEY,Authorization:'Bearer '+KEY,Prefer:'count=exact',Range:'0-0'}});
  return +((r.headers.get('content-range')||'0-0/0').split('/')[1])>0;
}
async function upsert(rows,asin,week){
  const q=`selling_partner_id=eq.${SPID}&marketplace_id=eq.${MKT}&asin=eq.${asin}&report_period=eq.WEEK&start_date=eq.${week}`;
  await fetch(`${U}/rest/v1/sqp_asin_rows?${q}`,{method:'DELETE',headers:{apikey:KEY,Authorization:'Bearer '+KEY}});
  if(!rows.length) return 0;
  const ins=await fetch(`${U}/rest/v1/sqp_asin_rows`,{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(rows)});
  return ins.ok?rows.length:0;
}
const CREATE_GAP=+(process.env.SQP_CREATE_GAP||8000); let gate=Promise.resolve();
async function spacedCreate(body){ let rel; const prev=gate; gate=new Promise(r=>rel=r); await prev;
  const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify(body)},12); setTimeout(rel,CREATE_GAP); return c; }
async function task(asin,week){
  if(EMPTY.has(asin+'|'+week)) return `skip ${week} ${asin} (bekannt leer)`;
  if(await hasData(asin,week)) return `skip ${week} ${asin}`;
  const body={reportType:'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',marketplaceIds:[MKT],dataStartTime:week+'T00:00:00Z',dataEndTime:satOf(week)+'T00:00:00Z',reportOptions:{reportPeriod:'WEEK',asin}};
  const c=await spacedCreate(body); if(!c) return `FAIL ${week} ${asin}`;
  const cj=await c.json(); if(!cj.reportId) return `ERR ${week} ${asin}: ${JSON.stringify(cj).slice(0,100)}`;
  const docId=await pollDoc(cj.reportId); if(!docId) return `FATAL ${week} ${asin}`;
  const n=await upsert(mapRows(await download(docId),asin),asin,week);
  if(n===0){ await markEmpty(asin,week); return `leer ${week} ${asin} (vermerkt)`; }
  return `ok ${week} ${asin}: ${n}`;
}
async function pool(tasks,conc){ let i=0,done=0; const runners=Array.from({length:conc},async()=>{
  while(i<tasks.length){ const idx=i++; const [asin,week]=tasks[idx];
    try{ const m=await task(asin,week); done++; console.log(`[${done}/${tasks.length}] ${m}`);}catch(e){done++;console.log(`[${done}/${tasks.length}] EXC ${week} ${asin}: ${e.message}`);} }});
  await Promise.all(runners); }
async function main(){
  await refreshAuth(); const asins=await rankAndCap(await listAsins()); const ws=weeks(NWEEKS);
  await loadEmpty();
  const tasks=[]; for(const a of asins) for(const w of ws) tasks.push([a,w]); // ASIN-major: wichtigste ASINs zuerst komplett
  console.log(`Wochen-Backfill: ${ws.length} Wochen (${ws[0]}..${ws[ws.length-1]}) × ${asins.length} ASINs = ${tasks.length} Tasks`);
  const t0=Date.now(); await pool(tasks,CONC); console.log(`FERTIG in ${Math.round((Date.now()-t0)/60000)} Min.`);
}
main().catch(e=>{console.error('FEHLER',e);process.exit(1);});
