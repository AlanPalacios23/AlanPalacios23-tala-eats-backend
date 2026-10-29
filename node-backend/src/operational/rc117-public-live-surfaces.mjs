/**
 * RC11.7 public surface probe, zero writes.
 * Network GET only. HTML+readiness never proves role-authenticated E2E,
 * financial reconciliation, backup restoration or operational signoff.
 */
export const LIVE_PUBLIC_SURFACES=Object.freeze([
 {kind:'api',url:'https://talaeats.alan-palacios-dev.com/api/v1/ready'},
 {kind:'client',url:'https://web-talaeats.alan-palacios-dev.com/clientes'},
 {kind:'restaurant',url:'https://restaurantes-talaeats.alan-palacios-dev.com/restaurante'},
 {kind:'driver',url:'https://repartidores-talaeats.alan-palacios-dev.com/repartidor'},
]);
const safeMessage=e=>e instanceof Error?e.name:'NETWORK_FAILED';
async function fetchOne(url,kind,fetcher){
 const status={kind,reachable:false,reason:'UNKNOWN'};
 try {
  const response=await fetcher(url,{method:'GET',redirect:'follow',
   cache:'no-store',signal:AbortSignal.timeout(9000),
   headers:{'Cache-Control':'no-cache','Accept':'text/html, application/json'}});
  if(!response.ok)return {...status,reason:'HTTP_'+response.status};
  const resolved=new URL(response.url||url);
  const target=new URL(url);
  if(resolved.origin!==target.origin)
   return {...status,reason:'CROSS_ORIGIN_REDIRECT'};
  if(kind==='api'){
   const contentType=response.headers.get('content-type')??'';
   if(!contentType.toLowerCase().includes('application/json'))
    return {...status,reason:'API_RETURNED_NON_JSON'};
   const data=await response.json();
   if(data?.ready!==true||data?.workerOnline!==true||
      data?.environment!=='production')
    return {...status,reason:'API_OR_WORKER_NOT_PRODUCTION_READY'};
   return {...status,reachable:true,reason:'READY_JSON_PRODUCTION'};
  }
  const contentType=response.headers.get('content-type')??'';
  if(!contentType.toLowerCase().includes('text/html'))
   return {...status,reason:'PORTAL_NOT_HTML'};
  const html=await response.text();
  if(html.length<40||html.length>512_000||!/<html\b/i.test(html)||
     !/<(?:script|link)\b/i.test(html))
   return {...status,reason:'PWA_SHELL_INVALID'};
  return {...status,reachable:true,reason:'PWA_SHELL_HTTP_ONLY'};
 } catch(e){return {...status,reason:safeMessage(e)};}
}
export async function probeLivePublicSurfaces(fetcher=fetch){
 const checks=[];
 for(const surface of LIVE_PUBLIC_SURFACES){
  checks.push(await fetchOne(surface.url,surface.kind,fetcher));
 }
 return {
  publicHttpReachable:checks.every(x=>x.reachable),
  checks,
  realCheckoutProven:false,driverPinE2EProven:false,
  stripeDeliveryProven:false,payoutsProven:false,
  backupRestoreProven:false,alertsProven:false,
  launchApproved:false,
 };
}
