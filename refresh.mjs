// Inkrementeller SQP-Refresh über ALLE Kunden aus sqp_clients.
// Zieht je Kunde: aktueller + vorheriger Monat (force), letzte N abgeschlossene Wochen (force),
// überspringt ältere vorhandene Perioden. Für den wöchentlichen Cloud-Job (GitHub Actions).
// ENV: SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: WEEKS (Default 3), CONC (Default 4)
//   SQP_ONLY=<Kundenname oder spid>  nur diesen Kunden refreshen (Einzel-Nachlauf nach Amazon-Timeouts)
//   SLACK_WEBHOOK_URL                Sammelmeldung: Kunden mit fehlgeschlagenen/abgebrochenen Reports bzw. nicht gestartet/uebersprungen
//   SQP_BREAKER (6)                  so viele Reports in Folge ohne Amazon-Antwort (TIMEOUT) => Kunde wird aufgegeben
//   SQP_BUDGET_MIN (270)             ab dieser Laufzeit keine NEUEN Kunden mehr; SQP_HARD_MIN (285): keine neuen Reports mehr
//   SQP_EXIT_MIN (300)               harter Stopp: Sammelmeldung + sauberes Ende (Exit 0), falls laufende Arbeit das Budget ueberschreitet
//   CONC_CLIENTS (3)                 Kunden parallel; Reihenfolge: aeltester Datenstand zuerst (Fallback woechentliche Rotation)
// Der Job endet auch bei abgebrochenen/nicht gestarteten Kunden mit Exit 0 (gruen) — die Slack-Sammelmeldung benennt sie.
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
const CID=process.env.SPAPI_CLIENT_ID, SEC=process.env.SPAPI_CLIENT_SECRET;
const U=process.env.SUPABASE_URL, KEY=process.env.SUPABASE_SERVICE_KEY;
const SPAPI='https://sellingpartnerapi-eu.amazon.com';
const NWEEKS=+(process.env.WEEKS||3), CONC=+(process.env.CONC||4);
const MKT_BY_CC={DE:'A1PA6795UKMFR9',FR:'A13V1IB3VIYZZH',IT:'APJ6JRA9NG5V4',ES:'A1RKKUPIHCS9HS',UK:'A1F83G8C2ARO7P',NL:'A1805IZSGTT6HS',SE:'A2NODRKZP88ZB9',PL:'A1C3SOZRARQ6R3',BE:'AMEN7PMS3EDWL'};
const sbHead={apikey:KEY,Authorization:'Bearer '+KEY};

// Einzel-Kunden-Lauf (16.10.): Amazon-Reports laufen bei einzelnen Kunden gelegentlich komplett
// in TIMEOUT (MGF - IT, 12.10.: alle 15 Reports, 0 Zeilen — der Job blieb trotzdem "gruen").
// Mit SQP_ONLY laesst sich so ein Kunde in Minuten statt in dem ~4h-Gesamtlauf nachholen.
export function pickClients(clients, only){
  const o=String(only||'').trim().toLowerCase(); if(!o) return clients;
  return clients.filter(c=>String(c.name||'').toLowerCase()===o||String(c.spid||'').toLowerCase()===o);
}
// Gesundheitscheck je Kunde: ein Report gilt als fehlgeschlagen bei TIMEOUT, Create-Fehler oder
// Ausnahme. "keine Daten (FATAL)" zaehlt NICHT mit — das ist bei laufender Woche/Monat normal.
// Bewusst Fehlschlag-Anteil statt "weniger Zeilen als ueblich": die Zeilenzahl schwankt je Woche
// legitim stark (siehe sqp_asin_rows), der Anteil gescheiterter Reports nicht.
export function assessClient(s, failShare=0.5){
  if(!s||!s.total) return null;
  const failed=s.timeouts+s.createFails+s.exc;
  // Abgebrochene Kunden (Circuit-Breaker / Zeitlimit) sind IMMER ein Problem, auch wenn erst < 50 % der Reports gescheitert sind
  if(s.aborted){
    const why=s.reason==='deadline'?'Zeitlimit des Laufs erreicht':`wegen dauerhafter Timeouts/Create-Fehler, ${s.timeouts+s.createFails} Reports ohne Amazon-Antwort`;
    return `abgebrochen (${why}): ${failed} von ${s.total} Reports fehlgeschlagen, ${s.skipped||0} gar nicht mehr versucht, ${s.rows} Zeilen geschrieben`;
  }
  if(failed/s.total<failShare) return null;
  return `${failed} von ${s.total} Reports fehlgeschlagen (${s.timeouts} Timeout${s.createFails?`, ${s.createFails} Create-Fehler`:''}${s.exc?`, ${s.exc} Ausnahmen`:''}), ${s.rows} Zeilen geschrieben`;
}
// ---- Resilienz (28.10.2026) ------------------------------------------------------------------------------------------------
// Am 26.10. standen die Brand-Analytics-Reports bei Amazon still: JEDER Report lief 20 Min in TIMEOUT, 15 Reports je Kunde =>
// ~80 Min pro Kunde, der Job wurde nach 5h45m bei Kunde 3 von 26 gekillt (cancelled) und zaehlte im Waechter nicht als Erfolg.
// Daher: Circuit-Breaker je Kunde, Ausfall-Erkennung ueber mehrere Kunden, Zeitbudget fuer neue Kunden, woechentlich rotierte
// Kundenreihenfolge (damit nicht immer dieselben hinten stehen) und eine Slack-Sammelmeldung mit den uebersprungenen Kunden.
export const weekIndex=ms=>Math.floor(ms/(7*24*3600e3));
// Zahl-Einstellung aus der Umgebung: fehlend/leer/Text/0/negativ/unendlich => Default (ein Tippfehler darf den Lauf nicht bei Minute 0 stoppen)
export function numEnv(v,def){ const s=String(v??'').trim(); const n=s===''?NaN:Number(s); return Number.isFinite(n)&&n>0?n:def; }
// Reihenfolge "aeltester Stand zuerst" (der Waechter meldet einen Kunden nach 9 Tagen ohne neue SQP-Zeilen): ein knappes Zeitbudget
// trifft so nicht jede Woche dieselben Kunden. Nie befuellte Kunden ganz vorn, Gleichstand = urspruengliche Reihenfolge.
// `last` = { [ingestKey(c)]: Zeitstempel in ms des neuesten sqp_asin_rows.ingested_at }. Fallback bei Abfragefehler: rotateClients.
export const ingestKey=c=>`${c.spid}|${String(c.marketplace||'DE').toUpperCase()}`;
export function staleFirst(clients,last){
  return clients.map((c,i)=>({c,i,t:Number.isFinite(last&&last[ingestKey(c)])?last[ingestKey(c)]:-Infinity})) // NaN/Infinity/fehlend = unbekannt
    .sort((a,b)=>(a.t-b.t)||(a.i-b.i)).map(x=>x.c);
}
export function rotateClients(clients, offset){
  const n=clients.length; if(!n) return [];
  const k=((offset%n)+n)%n; return [...clients.slice(k),...clients.slice(0,k)];
}
// N Timeouts in Folge OHNE Amazon-Antwort dazwischen => Kunde aufgeben. Jede Antwort (Zeilen oder "keine Daten"/FATAL) setzt zurueck.
export function makeBreaker(limit=6){ let n=0, tripped=false;
  return { timeout(){ n++; if(n>=limit) tripped=true; }, answered(){ n=0; }, get tripped(){ return tripped; } }; }
// Die letzten n fertigen Kunden alle abgebrochen UND ohne eine einzige Zeile => Amazon-Ausfall, keine neuen Kunden mehr starten
// (Ein vom Zeitlimit abgeschnittener Kunde — reason 'deadline' — beweist keinen Amazon-Ausfall und zaehlt nicht.)
// Breaker-Limit: ganze Zahl >= 1 (Bruchteile werden abgerundet), alles andere => 6
export function breakerLimit(v){ const n=Math.floor(numEnv(v,6)); return n>=1?n:6; }
// Was die Ausfall-Erkennung ueber einen fertigen Kunden sieht. Kleine Kunden (weniger Reports als das Breaker-Limit) koennen den Breaker nie ausloesen:
// komplett im Timeout ohne JEDE Amazon-Antwort (Zeilen oder "keine Daten") zaehlt trotzdem als tot.
export function finishedEntry(st,limit=6){
  const dead=!!st.aborted||(st.total>0&&st.rows===0&&!(st.answered>0)&&st.timeouts>=Math.min(limit,st.total));
  return {aborted:dead,rows:st.rows,reason:st.aborted?st.reason:(dead?'breaker':undefined)};
}
export function outageDetected(finished, n=3){ return finished.length>=n && finished.slice(-n).every(r=>r.aborted&&r.reason!=='deadline'&&!(r.rows>0)); }
export function budgetDecision({elapsedMs,budgetMs,outage}){ if(outage) return 'outage'; return elapsedMs>=budgetMs?'budget':'run'; }
export function buildSlackText({problems=[],notStarted=[],outage=false}){
  if(!problems.length&&!notStarted.length&&!outage) return null;
  const L=[];
  if(outage) L.push('⚠️ *SQP Weekly Refresh*: Amazon liefert gerade keine SQP-Reports (mehrere Kunden nacheinander komplett im Timeout) — Lauf vorzeitig beendet, Daten evtl. veraltet.');
  else if(problems.length) L.push(`⚠️ *SQP Weekly Refresh*: bei ${problems.length} Kunde(n) schlugen Reports fehl oder der Kunde wurde abgebrochen/uebersprungen (Amazon-Timeouts, Zeitlimit) — Daten evtl. veraltet:`);
  else L.push('⚠️ *SQP Weekly Refresh*: Zeitbudget des Laufs aufgebraucht — fuer die nicht gestarteten Kunden sind die Daten evtl. veraltet.');
  if(outage&&problems.length) L.push('Betroffene Kunden:');
  L.push(...problems.map(p=>`• ${p.name}: ${p.msg}`));
  if(notStarted.length) L.push(`Nicht gestartet (${notStarted.length}): ${notStarted.join(', ')}`);
  L.push('Nachholen nur fuer einen Kunden: Workflow "SQP Weekly Refresh" → Run workflow → only_client.');
  return L.join('\n');
}
const T0=Date.now();
// Zeitbudget: Job-Limit 345 Min, danach (im selben Job) asin-meta mit max. 35 Min (gemessen 19–27 Min). Ab BUDGET keine neuen Kunden, ab HARD
// keine neuen Reports mehr; laufende Arbeit beendet spaetestens der harte Stopp bei EXIT (300 Min) => Job-Ende <= ~336 Min.
// Gemessen (Laeufe #12/#16/#18/#19, Okt 2026): gesunde Refresh-Schritte dauern bis 233 Min, der letzte Kunde startet bis Min 219 — das Budget schneidet sie nicht.
const BUDGET_MS=numEnv(process.env.SQP_BUDGET_MIN,270)*60e3, HARD_DEADLINE=T0+numEnv(process.env.SQP_HARD_MIN,285)*60e3, BREAKER=breakerLimit(process.env.SQP_BREAKER), EXIT_MS=numEnv(process.env.SQP_EXIT_MIN,300)*60e3;
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
  const r=await fetch(`${U}/rest/v1/spapi_accounts?selling_partner_id=eq.${spid}&select=refresh_token`,{headers:sbHead,signal:AbortSignal.timeout(60000)});
  const rows=await r.json(); if(!rows[0]) return null;
  const t=await fetch('https://api.amazon.co.uk/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:rows[0].refresh_token,client_id:CID,client_secret:SEC}),signal:AbortSignal.timeout(60000)});
  return (await t.json()).access_token;
}
// Token-Verwaltung wie in sqp-backfill.mjs: LWA-Token laeuft nach 60min ab —
// ohne Erneuerung liefen ALLE Requests langer Laeufe ab Minute 60 in 403
// ("create fail"-Massen am 20.07./27.07./01.08.).
function makeApi(spid){ let H=null,t0=0;
  const auth=async()=>{ const at=await accessToken(spid); if(at){ H={'x-amz-access-token':at,'Content-Type':'application/json'}; t0=Date.now(); } return !!at; };
  const api=async function(path,opts={},retries=10,maxMs=0){ // maxMs: Gesamtzeit-Deckel aller Versuche (sonst bis zu retries x 98 s bei haengendem Endpoint)
    const tEnd=maxMs?Date.now()+maxMs:0;
    for(let i=0;i<retries;i++){
      if(tEnd&&Date.now()>tEnd) return null;
      if(!H||Date.now()-t0>50*60000){ if(!await auth()&&!H){ api.last='auth'; return null; } }
      let r; try{ r=await fetch(`${SPAPI}${path}`,{...opts,headers:{...H,...(opts.headers||{})},signal:AbortSignal.timeout(90000)}); }catch(e){ api.last='net'; await sleep(8000); continue; }
      if(r.status===429){ api.last='429'; await sleep(25000+Math.random()*10000);continue;}
      if(r.status===403){ api.last='403'; await auth(); continue; } // 403 = Zugriff/Token dieses Kunden, kein Amazon-weites Problem
      return r; } return null; };
  api.init=auth; return api; }
// 20 Min: Multi-ASIN-Reports stehen deutlich laenger IN_QUEUE als Einzel-Reports
async function pollDoc(api,id){ for(let i=0;i<240;i++){await sleep(5000);const g=await api(`/reports/2021-06-30/reports/${id}`);if(!g)return null;const gj=await g.json();if(gj.processingStatus==='DONE')return {docId:gj.reportDocumentId};if(['FATAL','CANCELLED'].includes(gj.processingStatus))return {fatal:true};} return {timeout:true}; }
async function download(api,docId){ const dr=await api(`/reports/2021-06-30/documents/${docId}`); if(!dr) throw new Error('Dokument-Abruf fehlgeschlagen (Rate-Limit?)');
  const drj=await dr.json(); if(!drj||!drj.url) throw new Error('Report-Dokument ohne Download-URL'); // crashte sonst den ganzen Lauf (20.07.)
  const raw=await fetch(drj.url,{signal:AbortSignal.timeout(600000)});let buf=Buffer.from(await raw.arrayBuffer());if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);return JSON.parse(buf.toString('utf8')); }
async function listAsins(api,mkt){ const c=await api(`/reports/2021-06-30/reports`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reportType:'GET_MERCHANT_LISTINGS_ALL_DATA',marketplaceIds:[mkt]})});
  // amazonDown: Amazon-weites Signal (Netz/429/5xx/Report bleibt haengen) — NICHT: 401/403/4xx (Zugriff des einzelnen Kunden), zu grosser Katalog
  const flag=(msg,down)=>Object.assign(new Error(msg),{amazonDown:!!down});
  if(!c){ const denied=api.last==='403'||api.last==='auth'; // Zugriff verweigert (Berechtigung/Token des Kunden) vs. Amazon/Netz
    throw flag(denied?'Listings-Report nicht angefordert (Zugriff verweigert: HTTP 403 bzw. kein gueltiges Token — Berechtigung des Kunden pruefen)':'Listings-Report nicht angefordert (Amazon/Netz nicht erreichbar)',!denied); }
  let cj; try{ cj=await c.json(); }catch(e){ cj={}; } // bei 5xx oft eine HTML-Gatewayseite statt JSON
  if(!cj.reportId) throw flag(`Listings-Report nicht angefordert (HTTP ${c.status})`,c.status>=500);
  const pd=await pollDoc(api,cj.reportId), docId=(pd||{}).docId;
  // FATAL/CANCELLED = Amazon hat geantwortet (z. B. keine Listings in diesem Marktplatz) => kein Ausfall; haengender Report oder Netz => Ausfall-Signal
  if(!docId) throw flag('Listings-Report nicht fertig geworden (grosser Katalog?) — Kunde wird uebersprungen',!pd?(api.last!=='403'&&api.last!=='auth'):!!pd.timeout);
  const dr=await api(`/reports/2021-06-30/documents/${docId}`);const drj=await dr.json();
  if(!drj||!drj.url) throw new Error('Listings-Report-Dokument ohne Download-URL — Kunde wird uebersprungen');
  const raw=await fetch(drj.url,{signal:AbortSignal.timeout(600000)});let buf=Buffer.from(await raw.arrayBuffer());if(drj.compressionAlgorithm==='GZIP')buf=zlib.gunzipSync(buf);
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
let HARD_STOP=false; // gesetzt vom harten Stopp: ab dann werden keine neuen Reports/Kunden mehr begonnen
let upserting=0; // laufende Schreibvorgaenge: der harte Stopp wartet darauf (kein Abbruch zwischen DELETE und POST)
async function upsert(...a){ upserting++; try{ return await upsertRows(...a); } finally{ upserting--; } }
async function upsertRows(rows,spid,mkt,asin,period,start){ const q=`selling_partner_id=eq.${spid}&marketplace_id=eq.${mkt}&asin=eq.${asin}&report_period=eq.${period}&start_date=eq.${start}`;
  await fetch(`${U}/rest/v1/sqp_asin_rows?${q}`,{method:'DELETE',headers:sbHead,signal:AbortSignal.timeout(120000)}); if(!rows.length)return 0;
  const ins=await fetch(`${U}/rest/v1/sqp_asin_rows`,{method:'POST',headers:{...sbHead,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(rows),signal:AbortSignal.timeout(120000)}); return ins.ok?rows.length:0; }

async function refreshClient(client){
  const {spid,marketplace,name}=client; const mkt=MKT_BY_CC[marketplace]||MKT_BY_CC.DE;
  const api=makeApi(spid); if(!await api.init()){console.log(`  ${name}: kein SP-API-Token`);return {skipMsg:'kein SP-API-Token'};}
  const asins=await rankAndCap(spid,marketplace, await applyBrandFilter(spid, await listAsins(api,mkt))); console.log(`  ${name}: ${asins.length} ASINs`);
  // Sicherheitsnetz (greift mit Top-50-Kappung praktisch nie mehr)
  if(asins.length>300){ console.log(`  ${name}: ${asins.length} ASINs ohne wirksamen Marken-Filter — ÜBERSPRUNGEN. Marken-Filter setzen, dann laeuft der Kunde wieder mit.`); return {skipMsg:`${asins.length} ASINs ohne wirksamen Marken-Filter`,amazonAnswered:true}; }
  // Aufgaben: MONTH (prev+cur), WEEK (letzte N) — alle force (überschreiben),
  // als 18er-ASIN-Batches je Periode (Amazon-Limit 200 Zeichen; live verifiziert 11.08.)
  const periods=[]; for(const m of months()) periods.push({period:'MONTH',start:m,end:monthEnd(m)});
  for(const w of weeks(NWEEKS)) periods.push({period:'WEEK',start:w,end:satOf(w)});
  const jobs=[]; for(let s=0;s<asins.length;s+=18){ const grp=asins.slice(s,s+18); for(const p of periods) jobs.push({batch:grp,...p}); }
  // Create-Gate (Rate-Limit) + Concurrency für Poll/Download
  let gate=Promise.resolve(); const spacedCreate=async body=>{let rel;const prev=gate;gate=new Promise(r=>rel=r);await prev;const c=await api(`/reports/2021-06-30/reports`,{method:'POST',body:JSON.stringify(body)},12,8*60e3);setTimeout(rel,8000);return c;};
  const breaker=makeBreaker(BREAKER);
  let i=0,done=0,total=jobs.length; const st={total,timeouts:0,createFails:0,exc:0,rows:0,answered:0,aborted:false,skipped:0,reason:null};
  const worker=async()=>{ while(i<jobs.length&&!breaker.tripped&&!HARD_STOP&&Date.now()<HARD_DEADLINE){ const j=jobs[i++];
    try{ const body={reportType:'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',marketplaceIds:[mkt],dataStartTime:j.start+'T00:00:00Z',dataEndTime:j.end+'T00:00:00Z',reportOptions:{reportPeriod:j.period,asin:j.batch.join(' ')}};
      const c=await spacedCreate(body); const cj=c?await c.json():{}; done++;
      if(!cj.reportId){st.createFails++;if(!c&&api.last!=='403'&&api.last!=='auth')breaker.timeout();/* api() gab auf (Netz/429): Amazon antwortet nicht => zaehlt wie ein Timeout; 403/Auth = Zugriff dieses Kunden, kein Stillstand */console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start} [${j.batch.length}]: create fail ${c?c.status:'-'} ${JSON.stringify(cj).slice(0,120)}`);continue;}
      const pd=await pollDoc(api,cj.reportId);
      if(!pd||pd.timeout){st.timeouts++;breaker.timeout();console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start} [${j.batch.length} ASINs]: TIMEOUT`);continue;}
      if(pd.fatal){
        breaker.answered(); st.answered++; // Amazon hat geantwortet (nur keine Daten) — kein Ausfall
        // FATAL = keine Daten fuer die Anfrage; bei Batches Rest einzeln — hier nur loggen
        // (der Backfill pflegt die Leer-Vermerke; Refresh laeuft force ohne EMPTY-Logik)
        console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start} [${j.batch.length} ASINs]: keine Daten (FATAL)`);continue;
      }
      const rows=(await download(api,pd.docId)).dataByAsin||[]; breaker.answered(); st.answered++;
      if(j.batch.length>1&&rows.length&&rows[0].asin===undefined){ console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start}: Zeilen ohne asin-Feld — Batch übersprungen (Format prüfen!)`); continue; }
      const byAsin=new Map(j.batch.map(a=>[a,[]]));
      for(const r of rows){ const a=String(r.asin||j.batch[0]).toUpperCase(); if(byAsin.has(a)) byAsin.get(a).push(r); }
      let n=0;
      for(const [a,rws] of byAsin){ if(HARD_STOP) break; // nach dem harten Stopp keine neuen DELETE+POST-Paare mehr beginnen (laufende werden abgewartet)
        n+=await upsert(mapRows({dataByAsin:rws},spid,mkt,a,j.period,j.start),spid,mkt,a,j.period,j.start); }
      st.rows+=n; if(done%5===0||n===0) console.log(`  ${name} [${done}/${total}] ${j.period} ${j.start} [${j.batch.length} ASINs]: ${n} Zeilen`);
    }catch(e){done++;st.exc++;console.log(`  ${name} [${done}/${total}] EXC ${j.period} ${j.start}: ${e.message}`);} } };
  await Promise.all(Array.from({length:CONC},worker));
  st.skipped=jobs.length-i;
  if(st.skipped>0){ st.aborted=true; st.reason=breaker.tripped?'breaker':'deadline'; // nur wenn wirklich Reports uebrig blieben
    console.log(`  ${name}: ABGEBROCHEN (${breaker.tripped?`${BREAKER} Reports in Folge ohne Amazon-Antwort`:'Zeitlimit des Laufs'}), ${st.skipped} von ${total} Reports nicht mehr versucht.`); }
  else console.log(`  ${name}: fertig (${total} Batch-Reports).`);
  return st;
}

// Neuester sqp_asin_rows.ingested_at je Kunde (gleiche Abfrage wie der Waechter, Check 4b); Fehler => Exception (Aufrufer nutzt die Rotation)
async function lastIngestMap(clients){
  const out={}; let idx=0;
  const w=async()=>{ while(idx<clients.length){ const c=clients[idx++]; const mkt=MKT_BY_CC[c.marketplace]||MKT_BY_CC.DE;
    const r=await fetch(`${U}/rest/v1/sqp_asin_rows?selling_partner_id=eq.${c.spid}&marketplace_id=eq.${mkt}&select=ingested_at&order=ingested_at.desc&limit=1`,{headers:sbHead,signal:AbortSignal.timeout(30000)});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const rows=await r.json(); const ts=rows[0]&&rows[0].ingested_at?Date.parse(rows[0].ingested_at):NaN;
    if(!Number.isNaN(ts)) out[ingestKey(c)]=ts; } };
  await Promise.all(Array.from({length:6},w)); return out;
}
async function main(){
  const r=await fetch(`${U}/rest/v1/sqp_clients?active=eq.true&select=name,spid,marketplace,ads_profile_id&order=name.asc`,{headers:sbHead,signal:AbortSignal.timeout(60000)});
  let clients=(await r.json()).filter(c=>c.spid);
  const ONLY=(process.env.SQP_ONLY||'').trim();
  if(ONLY){ clients=pickClients(clients,ONLY); if(!clients.length){ console.error(`FEHLER: SQP_ONLY="${ONLY}" passt auf keinen aktiven Kunden (Name oder spid exakt angeben).`); process.exit(1); } console.log(`Einzel-Lauf: ${clients.map(c=>c.name).join(', ')}`); }
  const CONC_CLIENTS=+(process.env.CONC_CLIENTS||3);
  if(!ONLY){ // Fairness bei knappem Zeitbudget: aeltester Datenstand zuerst; Fallback woechentliche Rotation
    try{ clients=staleFirst(clients,await lastIngestMap(clients)); console.log('Reihenfolge: aeltester Datenstand zuerst.'); }
    catch(e){ console.log(`Reihenfolge: Datenstand nicht lesbar (${e.message}) — woechentliche Rotation.`); clients=rotateClients(clients,weekIndex(Date.now())*CONC_CLIENTS); }
  }
  console.log(`SQP-Refresh: ${clients.length} Kunde(n), ${NWEEKS} Wochen + akt./vor. Monat, ${CONC_CLIENTS} Kunden parallel.`);
  // Kunden PARALLEL: jeder Kunde hat ein eigenes Seller-Token und damit eigenes
  // SP-API-Quota — sequenziell sprengte der Lauf das Workflow-Timeout (>3h).
  let ci=0, outage=false; const allStats=[], skippedClients=[], finished=[], doneNames=new Set(); // finished: Eingabe der Ausfall-Erkennung (auch Listing-Fehler zaehlen)
  const clientWorker=async()=>{ while(ci<clients.length){
    // Vor jedem NEUEN Kunden: Zeitbudget und Ausfall-Erkennung (laufende Kunden machen bis zum harten Limit weiter).
    // Ein erkannter Ausfall gilt fuer alle Worker (sticky), auch wenn ein spaeter fertiger Kunde noch Zeilen geschrieben hat.
    if(outage||HARD_STOP) break;
    const dec=budgetDecision({elapsedMs:Date.now()-T0,budgetMs:BUDGET_MS,outage:outageDetected(finished)});
    if(dec!=='run'){ if(dec==='outage') outage=true; break; }
    const c=clients[ci++];
    console.log(`Kunde: ${c.name} (${c.spid})`);
    // Ein Kunde darf den Lauf nicht abreissen — Fehler loggen, in der Sammelmeldung auffuehren und weiter
    try{ const st=await refreshClient(c);
      if(st&&st.skipMsg){ skippedClients.push({name:c.name,msg:`übersprungen: ${st.skipMsg}`}); if(st.amazonAnswered) finished.push({aborted:false,rows:0}); } // Amazon hat geantwortet => unterbricht eine Ausfall-Serie
      else if(st){ allStats.push({name:c.name,...st});
        finished.push(finishedEntry(st,BREAKER)); }
    }catch(e){ console.log(`  ÜBERSPRUNGEN ${c.name}: ${e.message}`); skippedClients.push({name:c.name,msg:`übersprungen: ${e.message}`});
      if(e.amazonDown) finished.push({aborted:true,rows:0,reason:'breaker'}); } // nur Amazon-weite Listings-Fehler (flag in listAsins) zaehlen, keine Einzelfehler
    doneNames.add(c.name); } };
  // Sammelmeldung (16.10.): TIMEOUT-Reports werden oben nur geloggt, der Job endet trotzdem erfolgreich —
  // ein Kunde ohne einen einzigen erfolgreichen Report fiel so erst nach >9 Tagen im Waechter auf.
  const summarize=async(inFlight=[])=>{
    const problems=[...allStats.map(s=>({name:s.name,msg:assessClient(s)})).filter(p=>p.msg),...skippedClients,
      ...inFlight.map(n=>({name:n,msg:'abgebrochen: beim harten Laufzeit-Stopp noch nicht fertig (Zeitlimit des Laufs)'}))];
    const notStarted=clients.slice(ci).map(c=>c.name); // wegen Zeitbudget / Ausfall nicht mehr gestartet
    const text=buildSlackText({problems,notStarted,outage});
    if(text){
      console.log(text);
      const hook=process.env.SLACK_WEBHOOK_URL;
      if(!hook) console.log('(Kein SLACK_WEBHOOK_URL — nur im Log gemeldet.)');
      else try{ const sr=await fetch(hook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),signal:AbortSignal.timeout(30000)}); if(!sr.ok) console.log('Slack-POST fehlgeschlagen: HTTP '+sr.status); }catch(e){ console.log('Slack-POST fehlgeschlagen: '+e.message); }
    }
  };
  // Harter Stopp: das Budget (BUDGET/HARD) kann bereits laufende Arbeit nicht unterbrechen — im Extremfall (429-Retries + 20-Min-Poll +
  // Download) ueberschritte der Refresh-Schritt sonst das 345-Min-Job-Limit und der Lauf wuerde "cancelled". Daher: spaetestens bei
  // SQP_EXIT_MIN (300) Sammelmeldung senden und sauber mit Exit 0 beenden (asin-meta folgt danach mit eigenem 35-Min-Limit).
  const hardTimer=setTimeout(async()=>{
    HARD_STOP=true; // einmalige Sammelmeldung: Normalpfad und harter Stopp duerfen sich nicht ueberholen
    try{
      const inFlight=clients.slice(0,ci).map(c=>c.name).filter(n=>!doneNames.has(n));
      console.log(`HARTER STOPP nach ${Math.round((Date.now()-T0)/60000)} Min — noch laufend: ${inFlight.join(', ')||'-'}.`);
      await summarize(inFlight);
    }catch(e){ console.log('Sammelmeldung fehlgeschlagen: '+e.message); }
    for(let w=0;upserting>0&&w<300;w++) await sleep(500); // laufende Schreibvorgaenge (max. 150 s) zu Ende kommen lassen
    process.exit(0);
  },Math.max(0,T0+EXIT_MS-Date.now()));
  hardTimer.unref();
  await Promise.all(Array.from({length:Math.min(CONC_CLIENTS,clients.length)||1},clientWorker));
  clearTimeout(hardTimer);
  if(HARD_STOP) return; // der harte Stopp laeuft schon (Sammelmeldung + Exit 0) — nicht doppelt melden
  await summarize();
  console.log('ALLES FERTIG.');
}
// Nur bei direktem Start ausfuehren (damit pickClients/assessClient testbar importiert werden koennen)
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error('FEHLER',e);process.exit(1);});
