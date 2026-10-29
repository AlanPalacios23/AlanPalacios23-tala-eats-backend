/** RC136 Node parity: private identity evidence, never served as public media.
 * Files and metadata survive static PWA releases; Stripe/treasury untouched.
 */
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,readFile,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {Router,raw,type Request,type Response} from 'express';
import {current} from '../auth/routes.js';
import {account} from './routes.js';
import {db} from '../db.js';
import {MAX_MULTIPART_BYTES,UploadFailure,parsePrivateOnboardingEvidence} from './onboarding-upload-policy.js';

export const onboardingUploadRouter=Router();
const fileNamePattern=/^u([1-9][0-9]*)-[A-Za-z0-9_-]{32}\.(jpg|png|webp|pdf)$/;

function privateDirectory(){
 const production=process.env.NODE_ENV==='production';
 const value=process.env.TALA_ONBOARDING_PRIVATE_DIR||
   (production?'/home/tala-node-stage/.local/share/talaeats-private/onboarding':
     join(tmpdir(),'talaeats-node-onboarding-'+process.getuid()));
 // Production must never write evidence under an HTTP-served directory,
 // within a Git release, or into a world-readable /tmp path.
 if(!isAbsolute(value)||value.includes('..')||
    (production&&(!value.startsWith('/home/tala-node-stage/')||
      value.includes('/releases/')||value.includes('/public/')||
      value.includes('/dist/'))))
   throw new UploadFailure(503,'Almacenamiento privado sin configurar.');
 return value;
}
async function ensurePrivateDir(){
 const directory=privateDirectory();
 await mkdir(directory,{recursive:true,mode:0o700});
 const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)
   throw new UploadFailure(503,'Almacenamiento de documentos inseguro.');
 return directory;
}
function reject(res:Response,error:unknown){
 const status=error instanceof UploadFailure?error.status:
   typeof error==='object'&&error!==null&&
   'code' in error&&typeof error.code==='number'&&
   [400,401,403,404,409,413,415,422,429,503].includes(error.code)?error.code:503;
 const message=status!==503&&error instanceof Error?
   error.message: 'No se pudo procesar el documento en este momento.';
 res.setHeader('Cache-Control','private, no-store');
 res.status(status).json({error:message});
}
async function requester(req:Request){
 const {user}=await current(req);
 if(!user.isActive)throw new UploadFailure(403,'La cuenta no está activa.');
 return user;
}
// Authenticate BEFORE streaming up to 6 MB into memory.
onboardingUploadRouter.post('/onboarding-document',async(req,res,next)=>{
 try{
   await requester(req);
   next();
 }catch(e){reject(res,e);}
},raw({type:'multipart/form-data',limit:'6mb'}),async(req,res)=>{
 let saved:string|undefined;
 try{
   const user=await requester(req);
   if(!Buffer.isBuffer(req.body))throw new UploadFailure(415,'Documento multipart requerido.');
   const file=await parsePrivateOnboardingEvidence(req.header('content-type')??'',new Uint8Array(req.body));
   if(req.body.byteLength>MAX_MULTIPART_BYTES)
     throw new UploadFailure(413,'Solicitud de documento demasiado grande.');
   const directory=await ensurePrivateDir();
   const name='u'+user.id+'-'+randomBytes(24).toString('base64url')+'.'+
     ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'} as Record<string,string>)[file.mime];
   const target=join(directory,name);
   const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|
     constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   saved=target; // Only delete files successfully created by this request.
   try{await handle.writeFile(file.content);}finally{await handle.close();}
   await db.stageMediaAsset.create({data:{
     filename:name,category:'onboarding',userId:user.id,mime:file.mime,
     bytes:file.content.length,attached:false,
   }});
   res.setHeader('Cache-Control','private, no-store');
   res.status(200).json({url:'/api/v1/uploads/onboarding-document/'+name,
     name:file.name||'documento'});
 }catch(e){
   if(saved)await unlink(saved).catch(()=>{});
   reject(res,e);
 }
});
onboardingUploadRouter.get('/onboarding-document/:filename',async(req,res)=>{
 try{
   const user=await requester(req);
   const value=req.params.filename;
   const filename=Array.isArray(value)?value[0]:value;
   const m=filename?fileNamePattern.exec(filename):null;
   if(!m)throw new UploadFailure(404,'Documento no encontrado.');
   const asset=await db.stageMediaAsset.findUnique({where:{filename}});
   if(!asset||asset.category!=='onboarding')throw new UploadFailure(404,'Documento no encontrado.');
   if(user.role==='admin')await account(req,['admin']); // server-side TOTP
   else{
     if(asset.userId!==user.id)throw new UploadFailure(403,'Documento ajeno.');
     const requests=await db.opsOnboarding.findMany({where:{userId:user.id},
       select:{documentsJson:true},take:100,orderBy:{createdAt:'desc'}});
     const url='/api/v1/uploads/onboarding-document/'+filename;
     const linked=requests.some(row=>{
       try{
         const arr=JSON.parse(row.documentsJson);
         return Array.isArray(arr)&&arr.includes(url);
       }catch{return false;}
     });
     if(!linked)throw new UploadFailure(403,'Documento aún no vinculado a una solicitud.');
   }
   const directory=await ensurePrivateDir();
   const data=await readFile(join(directory,filename));
   res.setHeader('Cache-Control','private, no-store');
   res.setHeader('Content-Disposition','attachment; filename="documento-verificacion"');
   res.type(asset.mime);
   res.send(data);
 }catch(e){reject(res,e);}
});
onboardingUploadRouter.use((error:unknown,_req:Request,res:Response,next:(err?:unknown)=>void)=>{
 const status=typeof error==='object'&&error!==null&&
  'type' in error&&error.type==='entity.too.large';
 if(status){reject(res,new UploadFailure(413,'El envío excede el límite máximo permitido.'));return;}
 next(error);
});
