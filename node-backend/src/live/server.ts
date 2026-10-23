/**
 * RC8 isolated preproduction HTTP probe. Does not expose money-moving routes.
 * Bind loopback only; review before Cloudflared or any public cutover.
 * Independent production database schema provisioning is NOT implemented here.
 */
import {createServer} from 'node:http';

export const RC8_LOOPBACK_PORT=18290;
export function createLockedRc8Server(){
 return createServer((req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const path=(req.url??'').split('?')[0];
  if(req.method==='GET'&&path==='/api/v1/health'){
   res.writeHead(200);
   res.end(JSON.stringify({
    status:'locked',version:'rc8-live-candidate',
    checkoutEnabled:false,transfersEnabled:false,
    productionReady:false
   }));
   return;
  }
  if(req.method==='GET'&&path==='/api/v1/ready'){
   res.writeHead(503);
   res.end(JSON.stringify({
    ready:false,productionReady:false,
    reason:'LIVE_DEPENDENCIES_AND_FINANCIAL_RELEASE_NOT_SIGNED_OFF'
   }));
   return;
  }
  res.writeHead(503);
  res.end(JSON.stringify({error:'RC8_FINANCIAL_OPERATIONS_DISABLED'}));
 });
}
export function startLockedRc8Probe(env:NodeJS.ProcessEnv=process.env){
 if(env.NODE_ENV!=='production' ||
    env.RC8_LIVE_CHARGES_ENABLED!=='false' ||
    env.RC8_LIVE_TRANSFERS_ENABLED!=='false' ||
    env.RC8_LIVE_REFUNDS_ENABLED!=='false')
   throw Error('RC8_PROBE_REQUIRES_PRODUCTION_WITH_ALL_MONEY_WRITES_DISABLED');
 return createLockedRc8Server().listen(RC8_LOOPBACK_PORT,'127.0.0.1');
}
// Explicit start only: does not run during import, npm build, CI or RC7 PM2.
if(process.argv[1]?.endsWith('/live/server.js'))
 startLockedRc8Probe();
