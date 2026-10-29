/**
 * RC13.0: PRIVATE NON-FINANCIAL rehearsal for three existing live PWA roles.
 * It stores short-lived synthetic records in a Redis namespace, NEVER PG
 * orders, production ledger, Stripe, payment, transfer or withdrawal.
 */
import {randomUUID,randomInt} from 'node:crypto';
import {Router,type Request,type Response,type NextFunction} from 'express';
import type {Redis} from 'ioredis';
import {z} from 'zod';
import {db} from '../db.js';
import {config} from '../config.js';
import {current} from '../auth/routes.js';
import {
 applyRehearsalAction,publicDemoRoom,RehearsalError,
 type DemoRoom,type Actor,
} from './rehearsal-machine.js';

const PREFIX='tala:node:live:rehearsal:rc130:';
const TTL=3600;
const roomId=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessionSchema=z.strictObject({
 customer_user_id:z.number().int().safe().positive(),
 restaurant_user_id:z.number().int().safe().positive(),
 driver_user_id:z.number().int().safe().positive(),
});
const actionSchema=z.strictObject({
 action:z.enum(['place','accept','prepare','ready','assign',
  'pickup','depart','deliver','cancel']),
 product_name:z.string().trim().min(2).max(100).optional(),
 quantity:z.number().int().min(1).max(10).optional(),
 unit_price_minor:z.number().int().min(100).max(50000).optional(),
 payment_method:z.enum(['cash_demo','card_demo']).optional(),
 pin:z.string().regex(/^[0-9]{4}$/).optional(),
});
const LUA=[
 "local raw=redis.call('GET',KEYS[1])",
 "if not raw then return -1 end",
 "local ok,parsed=pcall(cjson.decode,raw)",
 "if not ok then return -2 end",
 "if tonumber(parsed.version)~=tonumber(ARGV[1]) then return 0 end",
 "redis.call('SET',KEYS[1],ARGV[2],'EX',tonumber(ARGV[3]))",
 "return 1",
].join('\n');
type Identity={userId:number;user:{twoFactorEnabled:boolean;role:string};mfaVerified:boolean};
function admin(identity:Identity){
 if(identity.user.role!=='admin'||!identity.user.twoFactorEnabled||
    !identity.mfaVerified)throw new RehearsalError(403,'DEMO_ADMIN_MFA_REQUIRED');
}
function actorFor(room:DemoRoom,who:Identity):Actor{
 if(who.userId===room.customerId)return 'customer';
 if(who.userId===room.restaurantId)return 'restaurant';
 if(who.userId===room.driverId)return 'driver';
 if(who.userId===room.adminId){admin(who);return 'admin';}
 throw new RehearsalError(403,'DEMO_NOT_PARTICIPANT');
}
function id(req:Request):string{
 const raw=req.params.id;
 const value=Array.isArray(raw)?raw[0]:raw;
 if(!value||!roomId.test(value))throw new RehearsalError(404,'DEMO_NOT_FOUND');
 return value;
}
function parse<T extends z.ZodType>(schema:T,value:unknown):z.output<T>{
 const result=schema.safeParse(value);
 if(!result.success)throw new RehearsalError(422,'DEMO_INPUT_INVALID');
 return result.data;
}
async function read(redis:Redis,key:string):Promise<DemoRoom>{
 const data=await redis.get(PREFIX+key);
 if(!data)throw new RehearsalError(404,'DEMO_EXPIRED_OR_NOT_FOUND');
 try{
  const room=JSON.parse(data) as DemoRoom;
  if(room.id!==key||!Number.isSafeInteger(room.version))
   throw Error('invalid');
  return room;
 }catch{throw new RehearsalError(503,'DEMO_STORAGE_INVALID');}
}
function handle(fn:(req:Request,res:Response)=>Promise<void>){
 return (req:Request,res:Response,next:NextFunction)=>{
  void fn(req,res).catch(err=>{
   if(err instanceof RehearsalError){
    res.status(err.statusCode).json({error:err.message,demo_only:true});
    return;
   }
   next(err);
  });
 };
}
export function buildRehearsalRouter(redis:Redis){
 const router=Router();
 router.use((_req,res,next)=>{
  res.setHeader('Cache-Control','private, no-store');
  next();
 });
 router.post('/sessions',handle(async(req,res)=>{
  if(config.NODE_ENV!=='production'||config.LIVE_DEMO_REHEARSAL_ENABLED!=='true')
   throw new RehearsalError(503,'DEMO_DISABLED');
  const who=await current(req);
  admin(who);
  const data=parse(sessionSchema,req.body);
  const ids=[data.customer_user_id,data.restaurant_user_id,data.driver_user_id];
  if(new Set([...ids,who.userId]).size!==4)
   throw new RehearsalError(422,'DEMO_PARTICIPANTS_MUST_BE_DISTINCT');
  const users=await db.authUser.findMany({
   where:{id:{in:ids},isActive:true},select:{id:true},
  });
  // Do not require commercial verification or Stripe Connect. A fresh
  // unverified user may take any simulated role when ADMIN authorizes it.
  if(users.length!==3)throw new RehearsalError(409,'DEMO_PARTICIPANTS_NOT_ACTIVE');
  const bucket=PREFIX+'limit:'+who.userId;
  const count=await redis.incr(bucket);
  if(count===1)await redis.expire(bucket,3600);
  if(count>12)throw new RehearsalError(429,'DEMO_CREATION_RATE_LIMITED');
  const now=new Date().toISOString(),room:DemoRoom={
   id:randomUUID(),version:0,adminId:who.userId,
   customerId:ids[0]!,restaurantId:ids[1]!,driverId:ids[2]!,
   status:'new',productName:null,quantity:0,unitPriceMinor:0,
   paymentMethod:null,deliveryPin:String(randomInt(1000,10000)),
   createdAt:now,updatedAt:now,
  };
  const created=await redis.set(PREFIX+room.id,JSON.stringify(room),'EX',TTL,'NX');
  if(created!=='OK')throw new RehearsalError(503,'DEMO_CREATE_UNAVAILABLE');
  res.status(201).json(publicDemoRoom(room,'admin'));
 }));
 router.get('/sessions/:id',handle(async(req,res)=>{
  const who=await current(req),room=await read(redis,id(req));
  const actor=actorFor(room,who);
  res.json(publicDemoRoom(room,actor));
 }));
 router.post('/sessions/:id/action',handle(async(req,res)=>{
  const who=await current(req),key=id(req),action=parse(actionSchema,req.body);
  for(let attempt=0;attempt<4;attempt++){
   const room=await read(redis,key);
   const actor=actorFor(room,who);
   const updated=applyRehearsalAction(room,actor,action.action,
    new Date().toISOString(),{
     productName:action.product_name,quantity:action.quantity,
     unitPriceMinor:action.unit_price_minor,paymentMethod:action.payment_method,
     pin:action.pin,expectedPin:room.deliveryPin??undefined,
    });
   const result=Number(await redis.eval(LUA,1,PREFIX+key,
    String(room.version),JSON.stringify(updated),String(TTL)));
   if(result===1){
    res.json(publicDemoRoom(updated,actor));return;
   }
   if(result===-1)throw new RehearsalError(404,'DEMO_EXPIRED_OR_NOT_FOUND');
   if(result===-2)throw new RehearsalError(503,'DEMO_STORAGE_INVALID');
  }
  throw new RehearsalError(409,'DEMO_RETRY_CONCURRENT_UPDATE');
 }));
 return router;
}
