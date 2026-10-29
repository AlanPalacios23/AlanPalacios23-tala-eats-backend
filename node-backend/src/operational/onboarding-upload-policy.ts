/** Private onboarding upload validation shared by HTTP and no-network tests.
 * Node 24's standards-based Request.formData() parses multipart, so we don't
 * install an unvetted package or implement a custom boundary parser.
 */
export const MAX_ONBOARDING_BYTES=5*1024*1024;
export const MAX_MULTIPART_BYTES=6*1024*1024;
export type OnboardingMime='image/jpeg'|'image/png'|'image/webp'|'application/pdf';
export class UploadFailure extends Error{
 constructor(public readonly status:number,message:string){super(message);}
}
export function contentMime(bytes:Uint8Array):OnboardingMime|null{
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x))return 'image/png';
 if(bytes.length>=12&&String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&
    String.fromCharCode(...bytes.subarray(8,12))==='WEBP')return 'image/webp';
 if(bytes.length>=5&&String.fromCharCode(...bytes.subarray(0,5))==='%PDF-')return 'application/pdf';
 return null;
}
export const extForMime:Record<OnboardingMime,string>={
 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'
};
export type PreparedEvidence={content:Uint8Array;mime:OnboardingMime;name:string};
export async function parsePrivateOnboardingEvidence(contentType:string,raw:Uint8Array):Promise<PreparedEvidence>{
 if(!/^multipart\/form-data;\s*boundary=/i.test(contentType)||contentType.length>230)
   throw new UploadFailure(415,'La solicitud debe contener un documento multipart válido.');
 if(raw.byteLength>MAX_MULTIPART_BYTES)
   throw new UploadFailure(413,'La solicitud supera el límite de 6 MB.');
 let data:FormData;
 try{
   const req=new Request('http://localhost/private-upload',{method:'POST',
     headers:{'content-type':contentType},body:new Uint8Array(raw)});
   data=await req.formData();
 }catch{
   throw new UploadFailure(400,'El contenido multipart no se pudo interpretar.');
 }
 const fields=[...data.entries()];
 if(fields.length!==1||fields[0]?.[0]!=='file'||typeof fields[0][1]==='string')
   throw new UploadFailure(422,'Adjunta un solo archivo en el campo file.');
 const file=fields[0][1] as File;
 if(!file.size||file.size>MAX_ONBOARDING_BYTES)
   throw new UploadFailure(file.size?413:422,'El archivo debe tener entre 1 byte y 5 MB.');
 const content=new Uint8Array(await file.arrayBuffer());
 const actual=contentMime(content);
 if(!actual||actual!==file.type)
   throw new UploadFailure(415,'El tipo real no coincide con JPG, PNG, WEBP o PDF declarado.');
 return {content,mime:actual,name:file.name.slice(0,160)};
}
