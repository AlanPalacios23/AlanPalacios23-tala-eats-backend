/** RC156 - fixed-origin, GET-only post-deploy verification.
 * No user inputs can alter destination hosts or turn a probe into a write.
 * All public URLs are explicit and reviewed by the operator.
 */
export const POSTDEPLOY_TARGETS=Object.freeze({
 stage:'https://api-stage-talaeats.alan-palacios-dev.com/api/v1',
 live:'https://talaeats.alan-palacios-dev.com/api/v1',
});
export const POSTDEPLOY_PWA_ROUTES=Object.freeze([
 'https://web-talaeats.alan-palacios-dev.com/iniciar',
 'https://restaurantes-talaeats.alan-palacios-dev.com/restaurante',
 'https://repartidores-talaeats.alan-palacios-dev.com/repartidor/acceso',
]);

export function parsePostdeployArgs(args){
 let mode=null;let pwas=false;
 for(const arg of args){
  if(arg==='--mode=stage'||arg==='--mode=live'){
   if(mode!==null)throw Error('ONLY_ONE_MODE_ALLOWED');
   mode=arg.slice('--mode='.length);
  }else if(arg==='--with-pwas'){pwas=true;}
  else throw Error('INVALID_ARGUMENT');
 }
 if(mode===null)throw Error('MODE_REQUIRED_STAGE_OR_LIVE');
 if(pwas&&mode!=='live')throw Error('PWA_ROUTES_ONLY_FOR_LIVE_GATE');
 return {mode,pwas};
}

export function buildReadOnlyProbes({mode,pwas}){
 if(!Object.hasOwn(POSTDEPLOY_TARGETS,mode))throw Error('INVALID_MODE');
 if(pwas&&mode!=='live')throw Error('INVALID_PWA_MODE');
 const origin=POSTDEPLOY_TARGETS[mode];
 const tests=[
  {id:'api_health',url:origin+'/health',kind:'health'},
  {id:'api_ready',url:origin+'/ready',kind:'ready'},
  {id:'support_requires_session',url:origin+'/platform/support',kind:'private'},
  {id:'support_capabilities_requires_session',url:origin+'/platform/support/capabilities',kind:'private'},
 ];
 if(pwas)POSTDEPLOY_PWA_ROUTES.forEach((url,index)=>{
  tests.push({id:['usuarios','restaurantes','repartidores'][index]+'_pwa',url,kind:'pwa'});
 });
 return tests;
}
export function validateReadOnlyProbe(probe,response,mode){
 const status=response?.status;
 const data=response?.body;
 if(probe.kind==='private'){
  if(status!==401)throw Error(probe.id+'_EXPECTED_HTTP_401_GOT_'+status);
  return 'AUTH_REQUIRED';
 }
 if(status!==200)throw Error(probe.id+'_HTTP_'+status);
 if(probe.kind==='pwa'){
  if(!(response.contentType||'').toLowerCase().includes('text/html'))
   throw Error(probe.id+'_NOT_HTML');
  return 'HTML_OK';
 }
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error(probe.id+'_INVALID_BODY');
 if(probe.kind==='health'){
  if(data.status!=='ok'||data.production!==(mode==='live'))
   throw Error(probe.id+'_ENVIRONMENT_MISMATCH');
  if(typeof data.online_payment_writes!=='boolean'||typeof data.version!=='string')
   throw Error(probe.id+'_UNVERIFIED_FIELDS');
  return 'HEALTH_OK';
 }
 if(probe.kind==='ready'){
  if(data.ready!==true||data.database!==true||data.redis!==true||
     data.workerOnline!==true||data.environment!==(mode==='live'?'production':'staging'))
   throw Error(probe.id+'_DEPENDENCIES_NOT_READY');
  if(typeof data.financialWrites!=='boolean')
   throw Error(probe.id+'_UNVERIFIED_FINANCIAL_STATE');
  return 'READY_OK';
 }
 throw Error('INVALID_PROBE');
}
