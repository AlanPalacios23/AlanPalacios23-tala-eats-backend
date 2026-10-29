import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 MAX_ONBOARDING_BYTES,MAX_MULTIPART_BYTES,UploadFailure,
 contentMime,parsePrivateOnboardingEvidence
} from '../dist/operational/onboarding-upload-policy.js';

const multipart=async(files)=>{
 const form=new FormData();
 for(const item of files)form.append('file',item);
 const r=new Request('http://localhost/',{method:'POST',body:form});
 return {type:r.headers.get('content-type'),body:new Uint8Array(await r.arrayBuffer())};
};
const photo=()=>new File([new Uint8Array([255,216,255,224,0,8])],
  'tarjeta-circulacion.jpg',{type:'image/jpeg'});

test('RC136 private upload: genuine mobile JPEG parses as one 6MB-bounded file',async()=>{
 const request=await multipart([photo()]);
 const data=await parsePrivateOnboardingEvidence(request.type,request.body);
 assert.equal(data.mime,'image/jpeg');
 assert.equal(data.name,'tarjeta-circulacion.jpg');
 assert.equal(data.content.length,6);
 assert.equal(MAX_ONBOARDING_BYTES,5242880);
 assert.equal(MAX_MULTIPART_BYTES,6291456);
});
test('RC136 private upload: rejects spoofed MIME even when extension looks correct',async()=>{
 const request=await multipart([new File(['malicious bytes'],'ine.jpg',{type:'image/jpeg'})]);
 await assert.rejects(parsePrivateOnboardingEvidence(request.type,request.body),
   e=>e instanceof UploadFailure&&e.status===415);
 assert.equal(contentMime(new TextEncoder().encode('%PDF-1.4')),'application/pdf');
});
test('RC136 private upload: refuses extra files, multipart without boundary and empty data',async()=>{
 const extra=await multipart([photo(),photo()]);
 await assert.rejects(parsePrivateOnboardingEvidence(extra.type,extra.body),
   e=>e instanceof UploadFailure&&e.status===422);
 await assert.rejects(parsePrivateOnboardingEvidence('text/plain',new Uint8Array([1])),
   e=>e instanceof UploadFailure&&e.status===415);
 const empty=await multipart([new File([],'missing.jpg',{type:'image/jpeg'})]);
 await assert.rejects(parsePrivateOnboardingEvidence(empty.type,empty.body),
   e=>e instanceof UploadFailure&&e.status===422);
});
test('RC136 private upload: rejects file above 5MB with a valid JPEG header',async()=>{
 const big=new Uint8Array(MAX_ONBOARDING_BYTES+1);
 big.set([255,216,255],0);
 const request=await multipart([new File([big],'huge.jpg',{type:'image/jpeg'})]);
 await assert.rejects(parsePrivateOnboardingEvidence(request.type,request.body),
   e=>e instanceof UploadFailure&&e.status===413);
});
test('RC136: backend exposes private endpoint and never serves uploads without auth',()=>{
 const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
 const route=readFileSync(new URL('../src/operational/onboarding-uploads.ts',import.meta.url),'utf8');
 const operations=readFileSync(new URL('../src/operational/routes.ts',import.meta.url),'utf8');
 assert.match(app,/app\.use\('\/api\/v1\/uploads', onboardingUploadRouter\)/);
 assert.match(route,/await requester\(req\)/);
 assert.match(route,/stageMediaAsset\.create/);
 assert.match(route,/account\(req,\['admin'\]\)/);
 assert.match(route,/documentsJson/);
 assert.match(route,/constants\.O_NOFOLLOW/);
 assert.match(route,/Cache-Control','private, no-store/);
 assert.match(operations,/stageMediaAsset\.findMany/);
 assert.match(operations,/\{32\}/); // existing validation requires exact 32-character secure token
 assert.doesNotMatch(app,/app\.use\('\/api\/v1\/uploads', express\.static/);
});
