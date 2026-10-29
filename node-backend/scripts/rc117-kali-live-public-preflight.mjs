#!/usr/bin/env node
/**
 * RC11.7 prelaunch PUBLIC GET checks for API/worker and the three PWAs.
 * Pinned to the production release and used only as an HTTP diagnostic.
 * Cannot perform login, create orders, charge, transfer, refund or payout.
 */
import {existsSync,lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {config} from '../dist/config.js';
import {probeLivePublicSurfaces} from '../src/operational/rc117-public-live-surfaces.mjs';
const sha=process.argv[2];
function hold(reason){console.log('RC117_PUBLIC_GATE=HOLD_'+reason);process.exitCode=2;}
async function main(){
 if(process.argv.length!==3||!/^[a-f0-9]{40}$/.test(sha??'')||
  process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
  homedir()!=='/home/tala-node-stage')return hold('USER_SHA_REQUIRED');
 const root=resolve('..');
 if(root!==join(homedir(),'tala-node-releases',sha)||
    execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sha)
  return hold('RELEASE_IDENTITY_MISMATCH');
 const env=join(homedir(),'.config/talaeats-node-live.env');
 if(!existsSync(env))return hold('ENV_MISSING');
 const stat=lstatSync(env);
 if(!stat.isFile()||stat.isSymbolicLink()||
    stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)
  return hold('ENV_PERMISSIONS');
 const u=new URL(config.DATABASE_URL);
 if(config.NODE_ENV!=='production'||config.PORT!==18190||
    u.hostname!=='127.0.0.1'||u.port!=='15445'||
    u.pathname!=='/tala_node_live')
  return hold('NOT_LIVE_RUNTIME');
 const report=await probeLivePublicSurfaces();
 for(const c of report.checks)
  console.log('RC117_'+c.kind.toUpperCase()+'='+(c.reachable?'PASS':'HOLD_'+c.reason));
 console.log('RC117_HTTP_ONLY='+report.publicHttpReachable);
 console.log('RC117_FINANCIAL_OPERATIONS=NONE');
 console.log('RC117_E2E_COMMERCIAL_PROOF=NOT_VERIFIED');
 console.log('RC117_BACKUP_ALERT_PROOF=NOT_VERIFIED');
 console.log('RC117_LAUNCH_APPROVAL=NO');
 if(!report.publicHttpReachable)return hold('LIVE_PUBLIC_SURFACE');
 console.log('RC117_PUBLIC_GATE=PASS_HTTP_ONLY_NOT_LAUNCH');
}
try{await main();}catch{hold('NETWORK_OR_CONFIGURATION_ERROR');}
