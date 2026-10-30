/**
 * RC144: durable, own-account-only driver avatar.
 * Stored OUTSIDE immutable release directories. The public GET route accepts
 * only random, opaque names; identity/ownership cannot be enumerated by ID.
 * No photos of official documents are ever returned by this route.
 */
import express,{Router, type Request, type Response, type NextFunction} from 'express';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,unlink,lstat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import sharp from 'sharp';
import {Redis} from 'ioredis';
import {current} from './auth/routes.js';
import {db} from './db.js';
import {config} from './config.js';

const avatars=Router();
const FILENAME=/^[a-f0-9]{40}\.webp$/;
const MAX_BYTES=4*1024*1024;
const MAX_EDGE=8192;
const AVATAR_ROUTE='/api/v1/driver/avatar/';
const mediaRoot=()=>config.DRIVER_AVATAR_MEDIA_DIR;

function storage():string{
 const dir=mediaRoot();
 if(config.DRIVER_AVATAR_UPLOAD_ENABLED!=='true'||!dir||!isAbsolute(dir)||
    dir==='/'||!resolve(dir).startsWith('/srv/talaeats-media/')||dir.includes('\0'))throw Error('AVATAR_STORAGE_DISABLED');
 return dir;
}
async function uploadBudget(userId:number):Promise<boolean>{
 const redis=new Redis(config.REDIS_URL,{lazyConnect:true,connectTimeout:2000,
  maxRetriesPerRequest:1,retryStrategy:()=>null});
 try{
  await redis.connect();
  const key='tala:driver:avatar:uploads:'+userId;
  const count=await redis.eval(
   "local v=redis.call('INCR',KEYS[1]);if v==1 then redis.call('EXPIRE',KEYS[1],3600) end;return v",
   1,key);
  return typeof count==='number'&&count<=12;
 }finally{redis.disconnect();}
}
function expectedFormat(type:string):'jpeg'|'png'|'webp'|null{
 if(type==='image/jpeg')return 'jpeg';
 if(type==='image/png')return 'png';
 if(type==='image/webp')return 'webp';
 return null;
}
export function buildDriverAvatarRouter(){
 // Public immutable bytes are only accessible by their unguessable path.
 // The HTML/order API controls who receives those paths.
 avatars.get('/:name',async(req,res)=>{
  const name=String(req.params.name??'');
  if(!FILENAME.test(name)){res.status(404).end();return;}
  let dir:string;
  try{dir=storage();}catch{res.status(503).end();return;}
  try{
   const image=await readFile(join(dir,name));
   res.setHeader('Content-Type','image/webp');
   res.setHeader('X-Content-Type-Options','nosniff');
   res.setHeader('Cache-Control','public, max-age=31536000, immutable');
   res.setHeader('Cross-Origin-Resource-Policy','same-site');
   res.status(200).send(image);
  }catch{res.status(404).end();}
 });
 avatars.post('/',express.raw({
  type:['image/jpeg','image/png','image/webp'],
  limit:MAX_BYTES,inflate:false,
 }),async(req:Request,res)=>{
  if(config.DRIVER_AVATAR_UPLOAD_ENABLED!=='true'){
   res.status(503).json({detail:'La foto de perfil todavía no está habilitada.'});return;
  }
  // A session belongs to exactly one user. Never trust a user_id from request.
  let userId:number;
  try{
   const s=await current(req);
   if(s.user.role!=='driver'||!s.user.isActive){
    res.status(403).json({detail:'Solo repartidores activos pueden cambiar esta foto.'});return;
   }
   userId=s.user.id;
  }catch{res.status(401).json({detail:'Inicia sesión como repartidor.'});return;}
  const format=expectedFormat(req.header('content-type')?.split(';')[0]?.trim().toLowerCase()??'');
  const input=req.body;
  if(!format||!Buffer.isBuffer(input)||input.length===0||input.length>MAX_BYTES){
   res.status(415).json({detail:'Solo fotografías JPG, PNG o WEBP de hasta 4 MB.'});return;
  }
  let dir:string;
  try{
   dir=storage();
   const meta=await lstat(dir);
   if(!meta.isDirectory()||meta.isSymbolicLink())throw Error('NOT_A_DIRECTORY');
  }catch{res.status(503).json({detail:'Almacenamiento de fotos no disponible.'});return;}
  try{
   if(!await uploadBudget(userId)){
    res.status(429).json({detail:'Demasiados cambios de foto. Inténtalo después.'});return;
   }
  }catch{
   res.status(503).json({detail:'No se pudo verificar el límite de subidas.'});return;
  }
  let output:Buffer;
  try{
   const parser=sharp(input,{limitInputPixels:MAX_EDGE*MAX_EDGE,failOn:'error'});
   const meta=await parser.metadata();
   if(meta.format!==format||!meta.width||!meta.height||
      meta.width<64||meta.height<64||
      meta.width>MAX_EDGE||meta.height>MAX_EDGE||
      (meta.pages??1)>1)throw Error('UNSAFE_IMAGE');
   // Normalize orientation, crop to square, remove EXIF/GPS/ICC metadata
   // and turn all accepted formats into a single safe, bounded WEBP file.
   output=await parser.rotate().resize(512,512,{fit:'cover',position:'attention',
     withoutEnlargement:false}).webp({quality:82,effort:4}).toBuffer();
   if(!output.length||output.length>500000)throw Error('OUTPUT_LIMIT');
  }catch{
   res.status(415).json({detail:'La imagen está dañada o no es una fotografía válida.'});return;
  }
  const name=randomBytes(20).toString('hex')+'.webp';
  const url=AVATAR_ROUTE+name;
  const path=join(dir,name);
  try{
   await writeFile(path,output,{flag:'wx',mode:0o600});
   try{
    await db.$transaction(async tx=>{
     await tx.authUser.update({where:{id:userId},data:{avatarUrl:url}});
     await tx.authAuditEvent.create({data:{
      userId,action:'driver.avatar.replace',entityType:'user',entityId:String(userId),
     }});
    });
   }catch(e){await unlink(path).catch(()=>{});throw e;}
   // Previous immutable URLs deliberately stay readable for old order
   // screens. A separate bounded-retention cleanup can remove orphaned assets.
   res.setHeader('Cache-Control','private, no-store');
   res.status(201).json({avatar_url:url,url});
  }catch{
   res.status(503).json({detail:'No pudimos guardar la fotografía. No se actualizó tu perfil.'});
  }
 });
 // Fail closed on large payloads and unsupported content-types.
 avatars.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  if(res.headersSent)return;
  const status=typeof error==='object'&&error!==null&&'status' in error?
    Number((error as {status?:number}).status):500;
  res.status(status===413?413:status===415?415:503).json({
   detail:status===413?'La fotografía excede 4 MB.':
     status===415?'Formato de imagen no permitido.':'No se pudo procesar la foto.',
  });
 });
 return avatars;
}
