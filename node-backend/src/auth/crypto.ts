// Direct, independent port of backend/app/security.py (Python).
// Separate staging secret; never import production JWT_SECRET or tokens.
import { createHash, createHmac, pbkdf2 as pbkdf2Callback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Callback);
export const PBKDF2_ITERATIONS = 600_000;

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('PASSWORD_LENGTH');
  }
  const salt = randomBytes(16);
  const digest = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  return ['pbkdf2_sha256', String(PBKDF2_ITERATIONS),
    salt.toString('base64'), digest.toString('base64')].join('$');
}

function strictBase64(s: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
    return undefined;
  }
  const buf = Buffer.from(s, 'base64');
  return buf.toString('base64') === s ? buf : undefined;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (typeof password !== 'string' || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
    return false;
  }
  const salt = strictBase64(parts[2] ?? '');
  const digest = strictBase64(parts[3] ?? '');
  if (!salt || salt.length !== 16 || !digest || digest.length !== 32) return false;
  const actual = await pbkdf2(password, salt, iterations, digest.length, 'sha256');
  return timingSafeEqual(actual, digest);
}

function b64url(raw: Buffer | string): string {
  return Buffer.from(raw).toString('base64url');
}

export type Claims = {
  sub: string;
  role?: string;
  iat: number;
  exp: number;
  jti?: string;
  device?: string;
  typ?: string;
  mfa?: boolean; // signed evidence from a successful TOTP login
};

function hmac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function signAccessToken(userId: number, role: string, secret: string,
  nowSeconds = Math.floor(Date.now() / 1000), lifetimeSeconds = 480 * 60,
  mfaVerified = false): string {
  if (!Number.isSafeInteger(userId) || userId <= 0 || secret.length < 40 ||
      !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new Error('INVALID_STAGE_JWT_CONFIG');
  }
  const payload: Claims = {
    sub: String(userId), role, iat: nowSeconds, exp: nowSeconds + lifetimeSeconds,
    jti: randomBytes(18).toString('base64url'),
    ...(mfaVerified?{mfa:true}:{}),
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const message = header + '.' + b64url(JSON.stringify(payload));
  return message + '.' + b64url(hmac(secret, message));
}

export function signDeviceToken(userId: number, deviceHash: string, secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!deviceHash || !/^[a-f0-9]{64}$/.test(deviceHash) || secret.length < 40) {
    throw new Error('INVALID_DEVICE_ATTESTATION');
  }
  const payload: Claims = {
    sub: String(userId), device: deviceHash, typ: 'talaeats-device',
    iat: nowSeconds, exp: nowSeconds + 180 * 86400,
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const message = header + '.' + b64url(JSON.stringify(payload));
  return message + '.' + b64url(hmac(secret, message));
}

export function verifyToken(raw: string, secret: string,
  nowSeconds = Math.floor(Date.now() / 1000), leewaySeconds = 0): Claims | null {
  if (typeof raw !== 'string' || raw.length > 4096 || secret.length < 40 ||
      !Number.isSafeInteger(leewaySeconds) || leewaySeconds < 0 || leewaySeconds > 60) return null;
  const fragments = raw.split('.');
  if (fragments.length !== 3) return null;
  const [headerPart, bodyPart, sigPart] = fragments;
  if (!headerPart || !bodyPart || !sigPart) return null;
  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256' || header?.typ !== 'JWT' ||
        header?.crit !== undefined || header?.b64 !== undefined) return null;
    const signature = Buffer.from(sigPart, 'base64url');
    const expected = hmac(secret, headerPart + '.' + bodyPart);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const claims = JSON.parse(Buffer.from(bodyPart, 'base64url').toString('utf8')) as Claims;
    if (!claims || !/^[1-9][0-9]*$/.test(claims.sub) ||
        !Number.isSafeInteger(Number(claims.sub)) || !Number.isSafeInteger(claims.iat) ||
        !Number.isSafeInteger(claims.exp) || nowSeconds + leewaySeconds < claims.iat ||
        nowSeconds - leewaySeconds >= claims.exp || claims.exp <= claims.iat) return null;
    return claims;
  } catch {
    return null;
  }
}

// Python security.py uses RFC 6238 HMAC-SHA1, step 30s, 6 digits, window ±1.
function base32Decode(value: string): Buffer | null {
  if (!/^[A-Z2-7]+$/i.test(value)) return null;
  let bits = 0;
  let buffer = 0;
  const result: number[] = [];
  for (const c of value.toUpperCase()) {
    const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    if (n < 0) return null;
    buffer = (buffer << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(result);
}

function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  if (!key || key.length < 10 || !Number.isSafeInteger(counter) || counter < 0) {
    throw new Error('INVALID_TOTP');
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(msg).digest();
  const off = (digest.at(-1) ?? 0) & 15;
  const value = (digest.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

export function verifyTotp(secret: string, otp: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !/^[0-9]{6}$/.test(otp)) return false;
  const counter = Math.floor(nowSeconds / 30);
  try {
    return [-1, 0, 1].some(drift => {
      const i = counter + drift;
      return i >= 0 && timingSafeEqual(Buffer.from(totpAt(secret, i)), Buffer.from(otp));
    });
  } catch {
    return false;
  }
}

export function totpForTestOnly(secret: string, nowSeconds: number): string {
  return totpAt(secret, Math.floor(nowSeconds / 30));
}
