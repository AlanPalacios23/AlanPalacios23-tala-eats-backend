/** Pure Web Push safety policy: no network, DB or Stripe imports. */
export const PROMOTIONAL_PUSH_KINDS=new Set(['promo','promotion','marketing','advertising']);
export function validPushEndpoint(endpoint:string):boolean{
 try {
  const url=new URL(endpoint);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||
    (url.port&&url.port!=='443'))return false;
  const host=url.hostname.toLowerCase();
  return host==='fcm.googleapis.com'||host==='fcmregistrations.googleapis.com'||
   host==='updates.push.services.mozilla.com'||host==='web.push.apple.com'||
   host.endsWith('.push.apple.com')||host.endsWith('.notify.windows.com');
 }catch{return false;}
}
export function safeNotificationPath(kind:string,message:string):string{
 const m=message.match(/(?:pedido|orden)\s*#([1-9][0-9]{0,11})/i);
 return m&&['order','delivery','payment','restaurant_order'].includes(kind)?
  '/pedidos/'+m[1]:'/notificaciones';
}
