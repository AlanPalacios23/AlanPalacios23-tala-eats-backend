#!/usr/bin/env node
/** RC156 - read-only post-deployment smoke. NEVER run writes against LIVE.
 * Usage: node scripts/rc156-postdeploy-readonly.mjs --mode=stage
 *        node scripts/rc156-postdeploy-readonly.mjs --mode=live --with-pwas
 * It prints only probe IDs and statuses, never response bodies or tokens.
 */
import {buildReadOnlyProbes,parsePostdeployArgs,validateReadOnlyProbe}
 from './rc156-postdeploy-readonly-lib.mjs';

async function main(args){
 const config=parsePostdeployArgs(args);
 const probes=buildReadOnlyProbes(config);
 let failures=0;
 for(const probe of probes){
  try{
   const response=await fetch(probe.url,{
    method:'GET',
    redirect:'error',
    credentials:'omit',
    cache:'no-store',
    headers:{Accept:probe.kind==='pwa'?'text/html':'application/json'},
    signal:AbortSignal.timeout(8000),
   });
   const contentType=response.headers.get('content-type')||'';
   const body=probe.kind==='health'||probe.kind==='ready'
    ?await response.json().catch(()=>null):null;
   validateReadOnlyProbe(probe,{status:response.status,body,contentType},config.mode);
   console.log(probe.id+'=PASS');
  }catch(error){
   failures++;
   const reason=error instanceof Error?error.message:'UNVERIFIED';
   // Do not print body or URLs: even error messages from HTTP clients
   // can contain sensitive params or infrastructure details.
   const safeReason=/^[A-Z0-9_]+$/.test(reason)?reason:'UNAVAILABLE';
   console.error(probe.id+'=FAIL:'+safeReason);
  }
 }
 console.log('POSTDEPLOY_READ_ONLY='+(failures===0?'PASS':'FAIL'));
 console.log('PRODUCTION_MUTATIONS=ZERO');
 console.log('ACTIVE_GIT_SHA=NOT_VERIFIED_REQUIRES_KALI_RELEASE_CHECK');
 if(failures)process.exitCode=1;
}
main(process.argv.slice(2)).catch(()=>{
 console.error('INVALID_MODE_OR_ARGUMENTS');
 process.exitCode=2;
});
