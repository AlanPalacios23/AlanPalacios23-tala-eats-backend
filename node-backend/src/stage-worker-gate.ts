/**
 * RC8.12 stage-only order admission gate.
 * Redis heartbeat expires after 45 seconds without the owned PM2 worker.
 * A missing/unreachable key must never allow a NEW stage order to be accepted.
 * Production payout, LIVE Stripe and DB operations remain untouched.
 */
import {Redis} from 'ioredis';
import {config} from './config.js';

const STAGE_WORKER_KEY='tala:node:stage:worker:heartbeat';

export class StageWorkerUnavailable extends Error {
  readonly code=503;
  constructor(){super('No se pueden recibir pedidos: procesador de pedidos temporalmente no disponible');}
}

/** Injected probe supports deterministic tests, including Redis failures. */
export async function hasFreshStageWorker(probe:()=>Promise<string|null>):Promise<boolean>{
  try{return (await probe())==='online';}
  catch{return false;}
}

export async function requireStageCheckoutWorker():Promise<void>{
  if(config.NODE_ENV!=='staging')return;
  const redis=new Redis(config.REDIS_URL,{
    lazyConnect:true,connectTimeout:1200,maxRetriesPerRequest:1,retryStrategy:()=>null,
  });
  try{
    await redis.connect();
    if(!await hasFreshStageWorker(()=>redis.get(STAGE_WORKER_KEY)))
      throw new StageWorkerUnavailable();
  }catch{
    throw new StageWorkerUnavailable();
  }finally{
    redis.disconnect();
  }
}
