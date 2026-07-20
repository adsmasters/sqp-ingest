// Inkrementeller SQP-Refresh über ALLE Kunden aus sqp_clients.
// Zieht je Kunde: aktueller + vorheriger Monat (force), letzte N abgeschlossene Wochen (force),
// überspringt ältere vorhandene Perioden. Für den wöchentlichen Cloud-Job (GitHub Actions).
// ENV: SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: WEEKS (Default 3), CONC (Default 4)
import zlib from 'node:zlib';
const CID=process.env.SPAPI_CLIENT_ID, SEC=process.env.SPAPI_CLIENT_SECRET;
const U=process.env.SUPABASE_URL, KEY=process.env.SUPABASE_SERVICE_KEY;
const SPAPI='https://sellingpartnerapi-eu.amazon.com';
const NWEEKS=+(process.env.WEEKS||3), CONC=+(process.env.CONC||4);
const MKT_BY_CC={DE:'A1PA6795UKMFR9',FR:'A13V1IB3VIYZZH',IT:'APJ6JRA9NG5V4',ES:'A1RKKUPIHCS9HS',UK:'A1F83G8C2ARO7P',NL:'A1805IZSGTT6HS',SE:'A2NODRKZP88ZB9',PL:'A1C3SOZRARQ6R3',BE:'AMEN7PMS3EDWL'};
const sbHead={apikey:KEY,Authorization:'Bearer '+KEY};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const iso=d=>d.toISOString().slice(0,10);

function months(){ const n=new Date(); const cur=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),1));
  const prev=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth()-1,1)); return [iso(prev),iso(cur)]; }
const monthEnd=m=>{const d=new Date(m+'T00:00:00Z');return iso(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)));};
function weeks(n){ const now=new Date(); const day=now.getUTCDay();
  const curSun=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-day)); const out=[];
  for(let i=1;i<=n;i++){const s=new Date(curSun);s.setUTCDate(curSun.getUTCDate()-7*i);out.push(iso(s));} return out.reverse(); }
const satOf=s=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+6);return iso(d);};

async function accessToken(spid){
  const r=await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${spid}&select=refresh_token`,{headers:sbHead});
  const rows=await r.json(); if(!rows[0]) return null;
  const t=await fetch('https://api.amazon.co.uk/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:rows[0].refresh_token,client_id:CID,client_secret:SEC})});
  return (await t.json()).access_token;
}
function makeApi(H){ return async function api(path,opts={},retries=10){
  for(let i=0;i<retries;i++){ const r=await fetch(`${SPAPI}${path}`,{...opts,headers:{...H,...(opts.headers||{})}});
    if(r.status===429){await sleep(25000+Math.random()*10000);continue;} return r; } return null; }; }
async function pollDoc(api,id){ for(let i=0;i<120;i++){await sleep(5000);const g=await api(`/reports/2021-06-30/reports/${id}`);if(!g)return null;const gj=await g.json();if(gj.processingStatus==='DONE')return gj.reportDocumentId;if(['FATAL','CANCELLED'].includes(gj.processingStatus))return null;} return null; }
async function download(api,docId){ const dr=await api(`/reports/2021-06-30/documents/${docId}`);const drj=await dr.json();const raw=await fetch(drj.url);let buf=Buffer.from(await raw.arrayBuffer());if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);return JSON.parse(buf.toString('utf8')); }
async function listAsins(api,mkt){ const c=await api(`/reports/2021-06-30/reports`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reportType:'GET_MERCHANT_LISTINGS_ALL_DATA',marketplaceIds:[mkt]})});
  const docId=await pollDoc(api,(await c.json()).reportId);
  if(!docId) throw new Error('Listings-Report nicht fertig geworden (grosser Katalog?) — Kunde wird uebersprungen');
  const dr=await api(`/reports/2021-06-30/documents/${docId}`);const drj=await dr.json();
  if(!drj||!drj.url) throw new Error('Listings-Report-Dokument ohne Download-URL — Kunde wird uebersprungen');
  const raw=await fetch(drj.url);let buf=Buffer.from(await raw.arrayBuffer());if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);
  const lines=buf.toString('latin1').split('\n').filter(Boolean);const hdr=lines[0].split('\t');const iA=hdr.findIndex(h=>/asin[\s_]*1/i.test(h)),iS=hdr.findIndex(h=>/status/i.test(h));
  const ACT=new Set(['active','aktiv','actif','activo','attivo']); // Report ist lokalisiert (DE: "Aktiv")
  let asins=[...new Set(lines.slice(1).map(l=>l.split('\t')).filter(r=>ACT.has((r[iS]||'').trim().toLowerCase())).map(r=>r[iA]).filter(Boolean))];
  if(!asins.length) asins=[...new Set(lines.slice(1).flatMap(l=>l.split('\t')).filter(a=>/^B0[A-Z0-9]{8}$/.test((a||'').trim())))];
  return asins; }
// Marken-Filter (Union der brand_filter aller aktiven Kunden dieses Sellers); Fallback = alle
async function applyBrandFilter(spid,asins){
  const cr=await fetch(`${U}/rest/v1/sqp_clients?spid=eq.${spid}&active=eq.true&select=brand_filter`,{headers:sbHead});
  const cl=cr.ok?await cr.json():[];
  if(!cl.length||cl.some(c=>!c.brand_filter||!c.brand_filter.length)) return asins;
  const want=new Set(cl.flatMap(c=>c.brand_filter));
  const mr=await fetch(`${U}/rest/v1/sqp_asin_meta?spid=eq.${spid}&brand=not.is.null&select=asin,brand&limit=10000`,{headers:{...sbHead,Range:'0-9999'}});
  const meta=mr.ok?await mr.json():[];
  if(!meta.length) return asins;
  const byAsin=new Map(meta.map(m=>[m.asin,m.brand]));
  const keep=asins.filter(a=>want.has(byAsin.get(a)));
  if(!keep.length) return asins;
  console.log(`  Marken-Filter aktiv [${[...want].join(', ')}]: ${keep.length} von ${asins.length} ASINs.`);
  return keep;
}
const num=x=>(x&&typeof x==='object'&&'amount'in x)?x.amount:x;
function mapRows(data,spid,mkt,asin,period){ return (data.dataByAsin||[]).map(r=>({selling_partner_id:spid,marketplace_id:mkt,asin,report_period:period,start_date:r.startDate,end_date:r.endDate,
  search_query:r.searchQueryData?.searchQuery,search_query_score:r.searchQueryData?.searchQueryScore,search_query_volume:r.searchQueryData?.searchQueryVolume,
  total_query_impression_count:r.impressionData?.totalQueryImpressionCount,asin_impression_count:r.impressionData?.asinImpressionCount,asin_impression_share:r.impressionData?.asinImpressionShare,
  total_click_count:r.clickData?.totalClickCount,asin_click_count:r.clickData?.asinClickCount,asin_click_share:r.clickData?.asinClickShare,
  total_cart_add_count:r.cartAddData?.totalCartAddCount,asin_cart_add_count:r.cartAddData?.asinCartAddCount,asin_cart_add_share:r.cartAddData?.asinCartAddShare,
  total_purchase_count:r.purchaseData?.totalPurchaseCount,asin_purchase_count:r.purchaseData?.asinPurchaseCount,asin_purchase_share:r.purchaseData?.asinPurchaseShare,
  asin_median_purchase_price:num(r.purchaseData?.asinMedianPurchasePrice)})).filter(x=>x.search_query&&(+x.search_query_volume||0)>=(period==="WEEK"?10:50)); } // Mini-Volumen raus
async function upsert(rows,spid,mkt,asin,period,start){ const q=`selling_partner_id=eq.${spid}&marketplace_id=eq.${mkt}&asin=eq.${asin}&report_period=eq.${period}&start_date=eq.${start}`;
  await fetch(`${U}/rest/v1/sqp_asin_rows?${q}`,{method:'DELETE',headers:sbHead}); if(!rows.length)return 0;
  const ins=await fetch(`${U}/rest/v1/sqp_asin_rows`,{method:'POST',headers:{...sbHead,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(rows)}); return ins.ok?rows.length:0; }

async function refreshClient(client){
  const {spid,marketplace,name}=client; const mkt=MKT_BY_CC[marketplace]||MKT_BY_CC.DE;
  const at=await accessToken(spid); if(!at){console.log(`  ${name}: kein SP-API-Token`);return;}
  const H={'x-amz-access-token':at,'Content-Type':'application/json'}; const api=makeApi(H);
  const asins=await applyBrandFilter(spid, await listAsins(api,mkt)); console.log(`  ${name}: ${asins.length} ASINs`);
  // Aufgaben: MONTH (prev+cur), WEEK (letzte N) — alle force (überschreiben)
  const jobs=[]; for(const m of months()) for(const a of asins) jobs.push({a,period:'MONTH',start:m,end:monthEnd(m)});
  for(const w of weeks(NWEEKS)) for(const a of asins) jobs.push({a,period:'WEEK',start:w,end:satOf(w)});
  // Create-Gate (Rate-Limit) + Concurrency für Poll/Download
  let gate=Promise.resolve(); const spacedCreate=async body=>{let rel;const prev=gate;gate=new Promise(r=>rel=r);await prev;const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify(body)},12);setTimeout(rel,8000);return c;};
  let i=0,done=0,total=jobs.length;
  const worker=async()=>{ while(i<jobs.length){ const j=jobs[i++];
    try{ const body={reportType:'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',marketplaceIds:[mkt],dataStartTime:j.start+'T00:00:00Z',dataEndTime:j.end+'T00:00:00Z',reportOptions:{reportPeriod:j.period,asin:j.a}};
      const c=await spacedCreate(body); const cj=c?await c.json():{}; done++;
      if(!cj.reportId){console.log(`  [${done}/${total}] ${j.period} ${j.start} ${j.a}: create fail`);continue;}
      const docId=await pollDoc(api,cj.reportId); if(!docId){console.log(`  [${done}/${total}] ${j.period} ${j.start} ${j.a}: FATAL`);continue;}
      const n=await upsert(mapRows(await download(api,docId),spid,mkt,j.a,j.period,j.start),spid,mkt,j.a,j.period,j.start);
      if(done%10===0||n===0) console.log(`  [${done}/${total}] ${j.period} ${j.start} ${j.a}: ${n}`);
    }catch(e){done++;console.log(`  [${done}/${total}] EXC ${j.period} ${j.start} ${j.a}: ${e.message}`);} } };
  await Promise.all(Array.from({length:CONC},worker));
  console.log(`  ${name}: fertig (${total} Reports).`);
}

async function main(){
  const r=await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&select=name,spid,marketplace,ads_profile_id`,{headers:sbHead});
  const clients=(await r.json()).filter(c=>c.spid);
  console.log(`SQP-Refresh: ${clients.length} Kunde(n), ${NWEEKS} Wochen + akt./vor. Monat.`);
  for(const c of clients){
    console.log(`Kunde: ${c.name} (${c.spid})`);
    // Ein Kunde darf den Lauf nicht abreissen — Fehler loggen und weiter
    try{ await refreshClient(c); }catch(e){ console.log(`  ÜBERSPRUNGEN ${c.name}: ${e.message}`); }
  }
  console.log('ALLES FERTIG.');
}
main().catch(e=>{console.error('FEHLER',e);process.exit(1);});
