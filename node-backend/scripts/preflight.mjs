import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const expected = ['src/server.ts','src/worker.ts','prisma/schema.prisma','ecosystem.config.cjs'];
const missing = expected.filter(p => !existsSync(resolve(p)));
console.log('PROJECT_STRUCTURE=' + (missing.length ? 'FAIL' : 'PASS'));
const version = Number(process.versions.node.split('.')[0]);
console.log('NODE_24_LTS=' + (version===24 ? 'PASS' : 'FAIL'));
if (missing.length || version!==24) process.exitCode=1;
console.log('PRODUCTION_FINANCIAL_WRITES=DISABLED');
