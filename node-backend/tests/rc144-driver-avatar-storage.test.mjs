import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const media=read('src/driver-avatar.ts');
const app=read('src/app.ts');
const auth=read('src/auth/routes.ts');
const config=read('src/config.ts');
const schema=read('prisma/schema.prisma');
const market=read('src/marketplace/routes.ts');
const driver=read('src/marketplace/driver.ts');
test('driver profile media is disabled unless provisioned outside release',()=>{
 assert.match(config,/DRIVER_AVATAR_UPLOAD_ENABLED: z\.enum\(\['false','true'\]\)\.default\('false'\)/);
 assert.match(config,/DRIVER_AVATAR_MEDIA_DIR: z\.string/);
 assert.match(media,/config\.DRIVER_AVATAR_UPLOAD_ENABLED!=='true'/);
 assert.match(media,/if\(!meta\.isDirectory\(\)\)/);
 assert.doesNotMatch(media,/mkdir\(/);
});
test('only owner may POST and no user ID or destination is accepted',()=>{
 assert.match(media,/const s=await current\(req\)/);
 assert.match(media,/s\.user\.role!=='driver'/);
 assert.match(media,/userId=s\.user\.id/);
 assert.match(media,/tx\.authUser\.update\(\{where:\{id:userId\}/);
 assert.doesNotMatch(media,/req\.body\.user_id|req\.query\.user_id|req\.params\.userId/);
 assert.match(auth,/s\.user\.role==='driver'&&parsed\.data\.avatar_url!==undefined/);
});
test('file never keeps original EXIF, GPS, animation or metadata',()=>{
 for(const key of ["sharp(input","limitInputPixels:MAX_EDGE*MAX_EDGE","meta.format!==format",
  "meta.width>MAX_EDGE","meta.height>MAX_EDGE","(meta.pages??1)>1",
  ".rotate().resize(512,512",".webp({quality:82","output.length>500000",
  "randomBytes(20).toString('hex')","await writeFile(path,output,{flag:'wx',mode:0o600})"])
  assert.ok(media.includes(key),key);
 assert.match(media,/const FILENAME=\/\^\[a-f0-9\]\{40\}\\\.webp\$\//);
 assert.match(media,/X-Content-Type-Options','nosniff'/);
 assert.match(media,/Cache-Control','private, no-store'/);
});
test('media routes mounted ahead of global 128kb parser; webhooks remain raw',()=>{
 assert.ok(app.indexOf("buildDriverAvatarRouter()")<app.indexOf("app.use(express.json"));
 assert.ok(app.indexOf("buildIsolatedWebhookRouter")<app.indexOf("buildDriverAvatarRouter()"));
 assert.match(media,/express\.raw\(\{/);
 assert.match(media,/limit:MAX_BYTES,inflate:false/);
 assert.match(media,/await uploadBudget\(userId\)/);
});
test('shared field exists in PostgreSQL, dashboard, assigned order projections',()=>{
 assert.match(schema,/avatarUrl\s+String\?\s+@map\("avatar_url"\)/);
 assert.match(driver,/avatar_url:actor\.avatarUrl/);
 assert.match(market,/avatar_url:order\.driver\.avatarUrl/);
 assert.match(market,/orderInclude=\{items:true,driver:\{include:\{driverProfile:true\}\}\}/);
});
test('does not alter dispatch, Stripe, migrations or treasury',()=>{
 assert.doesNotMatch(media,/(stripe|checkout|transfer|withdrawal|dispatch|order\.(?:update|delete))/i);
 assert.match(media,/driver\.avatar\.replace/);
 assert.match(media,/await unlink\(path\)\.catch/);
});
