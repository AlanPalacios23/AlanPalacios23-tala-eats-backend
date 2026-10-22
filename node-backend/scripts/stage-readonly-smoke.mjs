#!/usr/bin/env node
// Read-only real HTTP smoke for Node staging. NEVER POSTs, changes accounts,
// touches DB directly or enables payments. Must run only with staging URL.
const raw=process.argv[2]??'http://127.0.0.1:18190/api/v1';
let origin;
try{
 origin=new URL(raw);
 const local=origin.protocol==='http:'&&origin.hostname==='127.0.0.1'&&origin.port==='18190';
 const publicStage=origin.protocol==='https:'&&
  origin.hostname==='api-stage-talaeats.alan-palacios-dev.com'&&!origin.port;
 if(!(local||publicStage)||origin.pathname!=='/api/v1'||
    origin.search||origin.hash||origin.username||origin.password)
  throw new Error('invalid stage origin');
}catch{
 console.error('ABORT_ONLY_KNOWN_STAGE_API_URL');
 process.exit(2);
}
const root=origin.href.replace(/\/$/,'');
async function request(route){
 const res=await fetch(root+route,{
  method:'GET',headers:{accept:'application/json'},
  redirect:'error',signal:AbortSignal.timeout(8000),
 });
 const body=await res.json().catch(()=>null);
 return {status:res.status,body};
}
const requireCheck=(ok,detail)=>{if(!ok)throw new Error('STAGE_SMOKE_'+detail);};
async function waitForApi(){
 for(let i=0;i<25;i++){
  try{
   const r=await request('/health');
   if(r.status===200&&r.body?.status==='ok')return;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 throw new Error('STAGE_SMOKE_API_NOT_RUNNING');
}
try{
 await waitForApi();
 const health=await request('/health');
 requireCheck(health.status===200&&health.body?.production===false&&
  health.body?.online_payment_writes===false,'HEALTH_STAGE_ONLY');
 const ready=await request('/ready');
 requireCheck(ready.status===200&&ready.body?.ready===true&&
  ready.body?.database===true&&ready.body?.redis===true,'DEPENDENCIES');
 requireCheck(ready.body?.productionReady===false&&
  ready.body?.environment==='staging'&&
  ready.body?.financialWrites===false,'NO_LIVE_WRITES');
 // Worker process starts after API. Give it a short, bounded chance to
 // publish the first heartbeat; never accept "API up" as proof the job
 // consumer runs. All requests are read-only GETs.
 let workerOnline=ready.body?.workerOnline===true;
 for(let attempt=0;!workerOnline&&attempt<20;attempt++){
  await new Promise(done=>setTimeout(done,350));
  const retry=await request('/ready');
  workerOnline=retry.status===200&&retry.body?.workerOnline===true;
 }
 requireCheck(workerOnline,'PM2_WORKER_HEARTBEAT');
 const stripe=await request('/payments/stripe/config');
 requireCheck(stripe.status===200&&stripe.body?.enabled===false&&
  stripe.body?.financial_writes_enabled===false,'STRIPE_DISABLED');
 for(const code of ['TALA-JAL','AMECA-JAL']){
  const catalog=await request('/restaurants?market_code='+code+'&limit=200&offset=0');
  requireCheck(catalog.status===200&&Array.isArray(catalog.body)&&
   catalog.body.every(x=>x?.market_code===code),'MARKET_ISOLATION_'+code);
 }
 const invalid=await request('/restaurants?market_code%5B%5D=TALA-JAL');
 requireCheck(invalid.status===422,'MALFORMED_MARKET_FILTER');
 console.log('STAGE_HTTP_SMOKE=PASS');
 console.log('STAGE_WORKER_HEARTBEAT=PASS');
 console.log('STAGE_MARKET_ISOLATION=PASS');
 console.log('STAGE_STRIPE_LIVE_WRITES=DISABLED');
 console.log('PRODUCTION_READY=NO');
}catch(error){
 console.error(error instanceof Error?error.message:'STAGE_SMOKE_UNKNOWN');
 process.exitCode=1;
}
