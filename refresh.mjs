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
// Token-Verwaltung wie in sqp-backfill.mjs: LWA-Token laeuft nach 60min ab —
// ohne Erneuerung liefen ALLE Requests langer Laeufe ab Minute 60 in 403
// ("create fail"-Massen am 20.07./27.07./01.08.).
function makeApi(spid){ let H=null,t0=0;
  const auth=async()=>{ const at=await accessToken(spid); if(at){ H={'x-amz-access-token':at,'Content-Type':'application/json'}; t0=Date.now(); } return !!at; };
  const api=async function(path,opts={},retries=10){
    for(let i=0;i<retries;i++){
      if(!H||Date.now()-t0>50*60000){ if(!await auth()&&!H) return null; }
      let r; try{ r=await fetch(`${SPAPI}${path}`,{...opts,headers:{...H,...(opts.headers||{})}}); }catch(e){ await sleep(8000); continue; }
      if(r.status===429){await sleep(25000+Math.random()*10000);continue;}
      if(r.status===403){ await auth(); continue; }
      return r; } return null; };
  api.init=auth; return api; }
// 20 Min: Multi-ASIN-Reports stehen deutlich laenger IN_QUEUE als Einzel-Reports
async function pollDoc(api,id){ for(let i=0;i<240;i++){await sleep(5000);const g=await api(`/reports/2021-06-30/reports/${id}`);if(!g)return null;const gj=await g.json();if(gj.processingStatus==='DONE')return gj.reportDocumentId;if(['FATAL','CANCELLED'].includes(gj.processingStatus))return null;} return null; }
async function download(api,docId){ const dr=await api(`/reports/2021-06-30/documents/${docId}`); if(!dr) throw new Error('Dokument-Abruf fehlgeschlagen (Rate-Limit?)');
  const drj=await dr.json(); if(!drj||!drj.url) throw new Error('Report-Dokument ohne Download-URL'); // crashte sonst den ganzen Lauf (20.07.)
  const raw=await fetch(drj.url);let buf=Buffer.from(await raw.arrayBuffer());if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);return JSON.parse(buf.toString('utf8')); }
async function listAsins(api,mkt){ const c=await api(`/reports/2021-06-30/reports`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reportType:'GET_MERCHANT_LISTINGS_ALL_DATA',marketplaceIds:[mkt]})});
  const docId=await pollDoc(api,(await c.json()).reportId);
  if(!docId) throw new Error('Listings-Report nicht fertig geworden (grosser Katalog?) — Kunde wird uebersprungen');
  const dr=await api(`/reports/2021-06-30/documents/${docId}`);const drj=await dr.json();
  if(!drj||!drj.url) throw new Error('Listings-Report-Dokument ohne Download-URL — Kunde wird uebersprungen');
  const raw=await fetch(drj.url);let buf=Buffer.from(await raw.arrayBuffer());if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);
  if(buf.length>256*1024*1024) throw new Error(`Listings-Report unplausibel gross (${Math.round(buf.length/1048576)} MB) — Kunde wird uebersprungen`); // Pixxprint lieferte 525MB
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
// Gleicher ASIN-Umfang wie der Backfill: Top 50 nach 30-Tage-Umsatz + manuell
// angeforderte Fokus-ASINs (asin_focus). Ohne Umsatzdaten wird nicht gekappt.
async function rankAndCap(spid,marketplace,asins){
  const cc=(marketplace||'DE').toUpperCase();
  const sales=new Map();
  try{ const r=await fetch(`${U}/rest/v1/asin_sales_traffic?spid=eq.${spid}&days=eq.30&marketplace=eq.${cc}&select=asin,sales`,{headers:{...sbHead,Range:'0-4999'}}); if(r.ok) for(const x of await r.json()) sales.set(x.asin,+x.sales||0); }catch(e){}
  let focus=[];
  try{ const fr=await fetch(`${U}/rest/v1/sqp_clients?spid=eq.${spid}&active=eq.true&marketplace=eq.${cc}&select=asin_focus`,{headers:sbHead}); if(fr.ok) focus=[...new Set((await fr.json()).flatMap(c=>c.asin_focus||[]))].filter(a=>/^B0[A-Z0-9]{8}$/i.test(a)).map(a=>a.toUpperCase()); }catch(e){}
  const ranked=[...asins].sort((a,b)=>(sales.get(b)||0)-(sales.get(a)||0));
  const capped=(sales.size&&ranked.length>50)?ranked.slice(0,50):ranked;
  const set=new Set(capped); const extra=focus.filter(a=>!set.has(a));
  if(capped.length<ranked.length) console.log(`  Top 50 von ${ranked.length} ASINs (Umsatz-Ranking)${extra.length?` + ${extra.length} Fokus-ASINs`:''}.`);
  return [...extra,...capped];
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
  const api=makeApi(spid); if(!await api.init()){console.log(`  ${name}: kein SP-API-Token`);return;}
  const asins=await rankAndCap(spid,marketplace, await applyBrandFilter(spid, await listAsins(api,mkt))); console.log(`  ${name}: ${asins.length} ASINs`);
  // Sicherheitsnetz (greift mit Top-50-Kappung praktisch nie mehr)
  if(asins.length>300){ console.log(`  ${name}: ${asins.length} ASINs ohne wirksamen Marken-Filter — ÜBERSPRUNGEN. Marken-Filter setzen, dann laeuft der Kunde wieder mit.`); return; }
  // Aufgaben: MONTH (prev+cur), WEEK (letzte N) — alle force (überschreiben),
  // als 18er-ASIN-Batches je Periode (Amazon-Limit 200 Zeichen; live verifiziert 11.08.)
  const periods=[]; for(const m of months()) periods.push({period:'MONTH',start:m,end:monthEnd(m)});
  for(const w of weeks(NWEEKS)) periods.push({period:'WEEK',start:w,end:satOf(w)});
  const jobs=[]; for(let s=0;s<asins.length;s+=18){ const grp=asins.slice(s,s+18); for(const p of periods) jobs.push({batch:grp,...p}); }
  // Create-Gate (Rate-Limit) + Concurrency für Poll/Download
  let gate=Promise.resolve(); const spacedCreate=async body=>{let rel;const prev=gate;gate=new Promise(r=>rel=r);await prev;const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify(body)},12);setTimeout(rel,8000);return c;};
  let i=0,done=0,total=jobs.length;
  const worker=async()=>{ while(i<jobs.length){ const j=jobs[i++];
    try{ const body={reportType:'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',marketplaceIds:[mkt],dataStartTime:j.start+'T00:00:00Z',dataEndTime:j.end+'T00:00:00Z',reportOptions:{reportPeriod:j.period,asin:j.batch.join(' ')}};
      const c=await spacedCreate(body); const cj=c?await c.json():{}; done++;
      if(!cj.reportId){console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start} [${j.batch.length}]: create fail ${c?c.status:'-'} ${JSON.stringify(cj).slice(0,120)}`);continue;}
      const docId=await pollDoc(api,cj.reportId); if(!docId){console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start} [${j.batch.length} ASINs]: FATAL`);continue;}
      const rows=(await download(api,docId)).dataByAsin||[];
      if(j.batch.length>1&&rows.length&&rows[0].asin===undefined){ console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start}: Zeilen ohne asin-Feld — Batch übersprungen (Format prüfen!)`); continue; }
      const byAsin=new Map(j.batch.map(a=>[a,[]]));
      for(const r of rows){ const a=String(r.asin||j.batch[0]).toUpperCase(); if(byAsin.has(a)) byAsin.get(a).push(r); }
      let n=0;
      for(const [a,rws] of byAsin) n+=await upsert(mapRows({dataByAsin:rws},spid,mkt,a,j.period,j.start),spid,mkt,a,j.period,j.start);
      if(done%5===0||n===0) console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start} [${j.batch.length} ASINs]: ${n} Zeilen`);
    }catch(e){done++;console.log(`  ${name} [${done}/${total}] EXC ${j.period} ${j.start}: ${e.message}`);} } };
  await Promise.all(Array.from({length:CONC},worker));
  console.log(`  ${name}: fertig (${total} Batch-Reports).`);
}

async function main(){
  const r=await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&select=name,spid,marketplace,ads_profile_id`,{headers:sbHead});
  const clients=(await r.json()).filter(c=>c.spid);
  const CONC_CLIENTS=+(process.env.CONC_CLIENTS||3);
  console.log(`SQP-Refresh: ${clients.length} Kunde(n), ${NWEEKS} Wochen + akt./vor. Monat, ${CONC_CLIENTS} Kunden parallel.`);
  // Kunden PARALLEL: jeder Kunde hat ein eigenes Seller-Token und damit eigenes
  // SP-API-Quota — sequenziell sprengte der Lauf das Workflow-Timeout (>3h).
  let ci=0;
  const clientWorker=async()=>{ while(ci<clients.length){ const c=clients[ci++];
    console.log(`Kunde: ${c.name} (${c.spid})`);
    // Ein Kunde darf den Lauf nicht abreissen — Fehler loggen und weiter
    try{ await refreshClient(c); }catch(e){ console.log(`  ÜBERSPRUNGEN ${c.name}: ${e.message}`); } } };
  await Promise.all(Array.from({length:Math.min(CONC_CLIENTS,clients.length)||1},clientWorker));
  console.log('ALLES FERTIG.');
}
main().catch(e=>{console.error('FEHLER',e);process.exit(1);});
