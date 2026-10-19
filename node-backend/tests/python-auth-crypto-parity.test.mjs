import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { hashPassword, verifyPassword, signAccessToken, verifyToken,
  signDeviceToken, verifyTotp, totpForTestOnly, sha256Hex,
  PBKDF2_ITERATIONS } from '../dist/auth/crypto.js';

const secret = 'stage-auth-fixture-' + 'B'.repeat(70);
test('Python compatibility: PBKDF2 SHA256 600k, salt16, digest32', async () => {
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  const stored = await hashPassword('correct-horse-battery-staple');
  assert.match(stored, /^pbkdf2_sha256\$600000\$/);
  const [, ,salt64,digest64] = stored.split('$');
  assert.equal(Buffer.from(salt64,'base64').length,16);
  assert.equal(Buffer.from(digest64,'base64').length,32);
  assert.equal(
    pbkdf2Sync('correct-horse-battery-staple',Buffer.from(salt64,'base64'),600000,32,'sha256')
      .toString('base64'), digest64);
  assert.equal(await verifyPassword('correct-horse-battery-staple',stored),true);
  assert.equal(await verifyPassword('wrong-password',stored),false);
});
test('fail closed for unknown, malformed and unsupported Python password hashes', async () => {
  for (const v of ['', 'bcrypt$something', 'pbkdf2_sha256$1$AA==$AA==',
    'pbkdf2_sha256$9999999999$AA==$AA==',
    'pbkdf2_sha256$600000$not_base64!!$AA==']) {
    assert.equal(await verifyPassword('anypassword',v),false);
  }
});
test('stage JWT HS256 with Python-compatible fields and cryptographic signature', () => {
  const token=signAccessToken(17,'customer',secret,1_800_000_000,480*60);
  const parts=token.split('.');
  assert.equal(parts.length,3);
  const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
  assert.equal(claims.sub,'17'); assert.equal(claims.role,'customer');
  assert.equal(claims.exp,1_800_028_800);
  assert.equal(claims.iat,1_800_000_000);
  assert.ok(claims.jti);
  assert.equal(createHmac('sha256',secret).update(parts[0]+'.'+parts[1])
    .digest('base64url'),parts[2]);
  assert.equal(verifyToken(token,secret,1_800_000_010)?.sub,'17');
  assert.equal(verifyToken(token,secret,1_800_028_801),null);
  assert.equal(verifyToken(token,secret+'different',1_800_000_001),null);
  assert.equal(verifyToken(token+'tampered',secret,1_800_000_001),null);
});
test('stage JWT rejects algorithm-confusion and weak JWT secrets', () => {
  assert.throws(()=>signAccessToken(1,'customer','too-short'),/INVALID_STAGE_JWT_CONFIG/);
  const token=signAccessToken(1,'customer',secret,1_800_000_000);
  const [,p,s]=token.split('.');
  const noalg=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url');
  assert.equal(verifyToken(noalg+'.'+p+'.'+s,secret,1_800_000_001),null);
});
test('device attestation Python fields and digest binding', () => {
  const idHash=sha256Hex('device-xyz');
  const token=signDeviceToken(8,idHash,secret,1_800_000_000);
  const c=verifyToken(token,secret,1_800_000_010);
  assert.equal(c?.typ,'talaeats-device');
  assert.equal(c?.device,idHash);
  assert.equal(c?.sub,'8');
});
test('TOTP with Python 30-second ±1 window and 6 digits', () => {
  const code=totpForTestOnly('JBSWY3DPEHPK3PXP',1_800_000_000);
  assert.match(code,/^\d{6}$/);
  assert.equal(verifyTotp('JBSWY3DPEHPK3PXP',code,1_800_000_000),true);
  assert.equal(verifyTotp('JBSWY3DPEHPK3PXP',code,1_800_000_030),true);
  assert.equal(verifyTotp('JBSWY3DPEHPK3PXP',code,1_800_000_120),false);
  assert.equal(verifyTotp('',code),false);
  assert.equal(verifyTotp('JBSWY3DPEHPK3PXP','12345X'),false);
});
