import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('RC813 env validator: missing OFF flags normalize to OFF, no secrets leaked',()=>{
  const python=`
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location(
  "validator",Path("scripts/rc813-create-parallel-stage-env.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

source={
  "NODE_ENV":"staging","HOST":"127.0.0.1","PORT":"18190",
  "DATABASE_URL":"postgresql://tala_node_stage:synthetic-secret@127.0.0.1:15435/tala_node_stage",
  "REDIS_URL":"redis://:synthetic-secret@127.0.0.1:16379/0",
}
assert module.check_source(source)==[]
for name in module.PAYMENT_FLAGS_OFF:
  bad=dict(source)
  bad[name]="true"
  assert name in module.check_source(bad), name
  bad[name]="garbled"
  assert name in module.check_source(bad), name
  bad[name]="false"
  assert name not in module.check_source(bad), name
for name,value in (
  ("NODE_ENV","production"),
  ("PORT","18192"),
  ("DATABASE_URL","postgresql://stage:secret@127.0.0.1:15445/talaeats_live"),
  ("REDIS_URL","redis://:secret@127.0.0.1:16379/2"),
  ("STRIPE_SECRET_KEY","sk_live_not_for_stage"),
  ("STRIPE_PUBLISHABLE_KEY","pk_live_not_for_stage"),
  ("STAGE_PARALLEL_ENABLED","true"),
):
  bad=dict(source)
  bad[name]=value
  assert module.check_source(bad), name
bad=dict(source)
bad["MP_ACCESS_TOKEN"]="token"
assert "MERCADOPAGO_NOT_ALLOWED" in module.check_source(bad)
print("RC813_STAGE_ENV_SOURCE_VALIDATOR_TEST_PASS")
`;
  const p=spawnSync('python3',['-c',python],{
    cwd:new URL('..',import.meta.url).pathname,encoding:'utf8'
  });
  assert.equal(p.status,0,p.stderr);
  assert.match(p.stdout,/RC813_STAGE_ENV_SOURCE_VALIDATOR_TEST_PASS/);
  assert.doesNotMatch(p.stdout,/synthetic-secret|sk_live_/);
});
