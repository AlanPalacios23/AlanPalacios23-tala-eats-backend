import { randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { Router, urlencoded, type Request, type Response, type NextFunction } from 'express';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { hashPassword, sha256Hex, signAccessToken, signDeviceToken,
  verifyPassword, verifyToken, verifyTotp } from './crypto.js';

// Python contract reference: backend/app/routes/auth.py, schemas.py, deps.py.
// Only a staging feature flag can mount these endpoints. No production data,
// no OAuth token impersonation, no LIVE Stripe, no email sent by this module.
const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(255),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({
  email: z.email().max(255), password: z.string(),
  otp: z.string().max(12).optional(),
});
const profileSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  avatar_url: z.string().trim().max(600).nullable().optional(),
  birth_date: z.string().trim().max(10).optional(),
});
// Python schemas.PasswordForgotRequest and PasswordResetConfirm.
const forgotSchema = z.strictObject({ email: z.email().max(255) });
const resetSchema = z.strictObject({
  token: z.string().min(20).max(300),
  password: z.string().min(8).max(128),
});
const RESET_GENERIC_REPLY = 'Si el correo está registrado, enviaremos instrucciones para restablecer la contraseña.';
const RESET_INVALID_REPLY = 'El enlace de recuperación es inválido o expiró';
const RESET_MINUTES = 30; // backend/app/config.py default; staging-only.
// Registered Android App Link; the staging APK must be installed on the device.
const RESET_BROWSER_URL = 'https://talaeats.alan-palacios-dev.com/api/v1/auth/password/reset-page';

const DUMMY_HASH = 'pbkdf2_sha256$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const AUTH_COOKIE = 'talaeats_session';
const TOKEN_LIFE_SECONDS = 480 * 60;
let limiterClient: Redis | null = null;

class HttpFailure extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    (err as { code?: string }).code === 'P2002';
}
function normalizedEmail(v: string): string { return v.trim().toLowerCase(); }
function remoteIp(req: Request): string {
  // Cloudflared reaches the API over loopback. Do not put every Internet
  // user into the same rate-limit bucket; never trust arbitrary XFF chains.
  const peer=req.socket.remoteAddress ?? 'unknown';
  const fromTunnel=peer==='127.0.0.1'||peer==='::1'||peer==='::ffff:127.0.0.1';
  const cloudflare=req.header('cf-connecting-ip')?.trim() ?? '';
  return (fromTunnel&&isIP(cloudflare)?cloudflare:peer).slice(0,80);
}
function header(req: Request, key: string): string {
  const v = req.header(key) ?? '';
  return v.trim();
}
function cookieValue(req: Request): string {
  const line = req.header('cookie') ?? '';
  const entry = line.split(';').map(s => s.trim()).find(s => s.startsWith(AUTH_COOKIE + '='));
  if (!entry) return '';
  try { return decodeURIComponent(entry.slice(AUTH_COOKIE.length + 1)); }
  catch { return ''; }
}
function suppliedToken(req: Request): string {
  const bearer = header(req, 'authorization');
  if (/^Bearer\s+/i.test(bearer)) return bearer.replace(/^Bearer\s+/i, '').trim();
  return cookieValue(req);
}
function publicUser(user: {
  id:number; name:string; email:string; role:string; authProvider:string;
  avatarUrl:string|null; phone:string; isActive:boolean; twoFactorEnabled:boolean;
  marketingOptIn:boolean; analyticsOptIn:boolean; personalizationOptIn:boolean; birthDate:string;
}) {
  return {
    id:user.id, name:user.name, email:user.email, role:user.role,
    auth_provider:user.authProvider, avatar_url:user.avatarUrl, phone:user.phone,
    is_active:user.isActive, two_factor_enabled:user.twoFactorEnabled,
    marketing_opt_in:user.marketingOptIn, analytics_opt_in:user.analyticsOptIn,
    personalization_opt_in:user.personalizationOptIn, birth_date:user.birthDate,
  };
}
function secret(): string {
  if (config.AUTH_V02_ENABLED !== 'true' || !config.AUTH_JWT_SECRET ||
      config.AUTH_JWT_SECRET.length < 40) {
    throw new HttpFailure(503, 'Autenticación de staging no configurada');
  }
  return config.AUTH_JWT_SECRET;
}
async function rateLimit(req: Request, op: string): Promise<void> {
  if (!limiterClient) {
    limiterClient = new Redis(config.REDIS_URL, {
      lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
  }
  const key = 'tala:node:v02:auth:rate:' + op + ':' + sha256Hex(remoteIp(req));
  try {
    const hits = await limiterClient.eval(
      "local c=redis.call('INCR',KEYS[1]); if c==1 then redis.call('EXPIRE',KEYS[1],60) end; return c",
      1, key);
    if (typeof hits !== 'number' || hits > 12) throw new HttpFailure(429, 'Demasiados intentos. Vuelve a intentarlo.');
  } catch (err) {
    if (err instanceof HttpFailure) throw err;
    throw new HttpFailure(503, 'Límite de autenticación no disponible');
  }
}
// Uniform per-email budget (for existing AND unknown emails). Prevents one
// attacker from flooding a known account with valid recovery links using
// many IPs. Redis outage fails closed instead of sending unbounded mail.
async function allowRecoveryEmail(email:string):Promise<boolean>{
 if(!limiterClient)throw new HttpFailure(503,'Límite de autenticación no disponible');
 const key='tala:node:v02:auth:password-reset-email:'+sha256Hex(email);
 try{
  const hits=await limiterClient.eval(
   "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",
   1,key);
  if(typeof hits!=='number'||hits<1)throw Error('BAD_COUNTER');
  return hits<=3;
 }catch{throw new HttpFailure(503,'Recuperación temporalmente no disponible');}
}
export async function current(req: Request) {
  const token = suppliedToken(req);
  if (!token) throw new HttpFailure(401, 'Sesión requerida');
  const claims = verifyToken(token, secret());
  if (!claims || !claims.jti || !claims.role) throw new HttpFailure(401, 'Sesión inválida o vencida');
  const session = await db.authDeviceSession.findUnique({
    where: { sessionHash: sha256Hex(token) }, include: { user: true },
  });
  if (!session || !session.active || !session.user.isActive ||
      claims.sub !== String(session.userId) || claims.role !== session.user.role) {
    throw new HttpFailure(401, 'Sesión no reconocida o revocada');
  }
  const deviceProof = header(req, 'x-device-token');
  if (deviceProof) {
    const device = header(req, 'x-device-id').slice(0, 256);
    const proof = verifyToken(deviceProof, secret());
    if (!proof || proof.typ !== 'talaeats-device' ||
        proof.sub !== String(session.userId) ||
        !device || proof.device !== sha256Hex(device)) {
      throw new HttpFailure(401, 'Identidad de dispositivo inválida');
    }
  }
  return {...session,mfaVerified:claims.mfa===true};
}
async function issue(req: Request, res: Response, user: Awaited<ReturnType<typeof db.authUser.create>>,
  mfaVerified=false) {
  // A post-enrollment session must be reissued by /login after OTP verification.
  const token = signAccessToken(user.id, user.role, secret(),undefined,undefined,mfaVerified);
  const rawId = header(req, 'x-device-id').slice(0, 256);
  const idHash = rawId ? sha256Hex(rawId) : '';
  let riskScore = 0;
  if (idHash) {
    const shared = await db.authDeviceSession.findFirst({
      where: { deviceIdHash:idHash, userId:{not:user.id} },
      select:{id:true},
    });
    if (shared) riskScore = 40;
  }
  await db.authDeviceSession.create({
    data:{
      userId:user.id, sessionHash:sha256Hex(token), deviceIdHash:idHash,
      deviceLabel:header(req,'user-agent').slice(0,200) || 'Dispositivo',
      platform:header(req,'x-talaeats-client').toLowerCase().slice(0,40) || 'unknown',
      ipHint:remoteIp(req), riskScore,
    },
  });
  res.cookie(AUTH_COOKIE, token, {
    httpOnly:true, secure:true, sameSite:'lax', path:'/', maxAge:TOKEN_LIFE_SECONDS*1000,
  });
  return {
    access_token:token, token_type:'bearer', user:publicUser(user),
    device_token:idHash ? signDeviceToken(user.id, idHash, secret()) : '',
  };
}

export const authRouter = Router();

authRouter.post('/register', async (req,res) => {
  await rateLimit(req,'register');
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpFailure(422, 'Datos de registro inválidos');
  const data = parsed.data;
  const email = normalizedEmail(data.email);
  const hash = await hashPassword(data.password);
  let user;
  try {
    user = await db.$transaction(async tx => {
      const created = await tx.authUser.create({
        data:{name:data.name, email, passwordHash:hash, role:'customer', authProvider:'local'},
      });
      // Exact Python wallet creation default; money still READ-ONLY.
      await tx.authLoyaltyAccount.create({
        data:{userId:created.id,
          referralCode:'TALA'+String(created.id)+String(randomInt(0,999999)).padStart(6,'0')},
      });
      await tx.authNotification.create({
        data:{
          userId:created.id, kind:'account', title:'Bienvenido a Tala Eats',
          message:'Tu cuenta y Tala Wallet están listas para usarse.',
        },
      });
      // Email outbox is durable but delivery worker is a future phase.
      await tx.authEmailOutbox.create({
        data:{
          toEmail:email, subject:'Bienvenido a Tala Eats',
          textBody:'Hola '+created.name+', tu cuenta de Tala Eats está activa.',
        },
      });
      return created;
    });
  } catch (err) {
    if (isUnique(err)) throw new HttpFailure(409, 'Ese correo ya está registrado');
    throw err;
  }
  res.status(201).json(await issue(req,res,user));
});
authRouter.post('/login', async (req,res) => {
  await rateLimit(req,'login');
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpFailure(422, 'Datos de inicio de sesión inválidos');
  const data = parsed.data;
  const user = await db.authUser.findUnique({
    where:{ email:normalizedEmail(data.email) },
  });
  const passOk = await verifyPassword(data.password,user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !passOk) {
    throw new HttpFailure(401, 'Correo o contraseña incorrectos');
  }
  if (!user.isActive) throw new HttpFailure(403, 'La cuenta está desactivada');
  const mfaVerified=user.twoFactorEnabled&&verifyTotp(user.totpSecret,data.otp??'');
  if(user.twoFactorEnabled&&!mfaVerified) {
    throw new HttpFailure(401, 'Código de verificación 2FA requerido o inválido');
  }
  res.json(await issue(req,res,user,mfaVerified));
});
authRouter.post('/logout', async (req,res) => {
  const token = suppliedToken(req);
  if (token) {
    await db.authDeviceSession.updateMany({
      where:{sessionHash:sha256Hex(token)}, data:{active:false},
    });
  }
  res.clearCookie(AUTH_COOKIE,{httpOnly:true,secure:true,sameSite:'lax',path:'/'});
  res.status(204).end();
});
authRouter.get('/me', async (req,res) => {
  const s = await current(req);
  res.json(publicUser(s.user));
});
authRouter.patch('/me', async (req,res) => {
  const s = await current(req);
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpFailure(422, 'Perfil inválido');
  const u = await db.authUser.update({
    where:{id:s.userId},
    data:{
      ...(parsed.data.name !== undefined ? {name:parsed.data.name} : {}),
      ...(parsed.data.phone !== undefined ? {phone:parsed.data.phone} : {}),
      ...(parsed.data.avatar_url !== undefined ? {avatarUrl:parsed.data.avatar_url} : {}),
      ...(parsed.data.birth_date !== undefined ? {birthDate:parsed.data.birth_date} : {}),
    },
  });
  await db.authAuditEvent.create({
    data:{userId:s.userId, action:'profile.update', entityType:'user', entityId:String(s.userId)},
  });
  res.json(publicUser(u));
});
authRouter.get('/devices', async (req,res) => {
  const s = await current(req);
  const rows = await db.authDeviceSession.findMany({
    where:{userId:s.userId}, orderBy:{createdAt:'desc'}, take:100,
  });
  res.json(rows.map(row=>({
    id:row.id, device_label:row.deviceLabel, platform:row.platform,
    risk_score:row.riskScore, trusted:row.trusted, active:row.active,
    current:row.id===s.id, created_at:row.createdAt, last_seen_at:row.lastSeenAt,
  })));
});
authRouter.post('/devices/revoke-others', async (req,res) => {
  const s = await current(req);
  const result = await db.$transaction(async tx => {
    const updates = await tx.authDeviceSession.updateMany({
      where:{userId:s.userId,id:{not:s.id},active:true},
      data:{active:false,trusted:false},
    });
    await tx.authAuditEvent.create({
      data:{userId:s.userId,action:'device.revoke_others',entityType:'user',
        entityId:String(s.userId),detail:'revoked='+String(updates.count)},
    });
    return updates.count;
  });
  res.json({revoked:result,current_device_id:s.id});
});
authRouter.post('/devices/:deviceId/revoke', async (req,res) => {
  const s = await current(req);
  const id = Number(req.params.deviceId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpFailure(404,'Dispositivo no encontrado');
  const result = await db.$transaction(async tx => {
    const existing = await tx.authDeviceSession.findFirst({where:{id,userId:s.userId}});
    if (!existing) throw new HttpFailure(404,'Dispositivo no encontrado');
    await tx.authDeviceSession.update({
      where:{id},data:{active:false,trusted:false},
    });
    await tx.authAuditEvent.create({
      data:{userId:s.userId,action:'device.revoke',entityType:'device_session',
        entityId:String(id),beforeJson:JSON.stringify({active:existing.active,trusted:existing.trusted}),
        afterJson:JSON.stringify({active:false,trusted:false})},
    });
    return existing.id;
  });
  res.json({revoked:true,device_id:result,current:result===s.id});
});
authRouter.get('/google/config', (_req,res)=>{
  res.json({enabled:false,client_id:null});
});
authRouter.post('/google', (_req,res)=>{
  res.status(503).json({detail:'Google Sign-In aún no está configurado en staging'});
});
// The outbox is queued for a restricted staging email sender, never delivered
// by the HTTP request itself. In CI only, recovery queues without a provider.
authRouter.post('/password/forgot', async (req,res) => {
  await rateLimit(req,'password-forgot');
  // Apply the same response for every identity when delivery is unavailable.
  // Never claim a recovery email was sent while staging has no mail provider.
  const mailAvailable=config.NODE_ENV==='production'
    ? config.LIVE_AUTH_EMAIL_DELIVERY_MODE==='resend'&&
      config.LIVE_AUTH_EMAIL_SENDER_APPROVED==='true'
    : config.STAGE_EMAIL_DELIVERY_MODE==='resend'||process.env.CI==='true';
  if(!mailAvailable)
    throw new HttpFailure(503,'Recuperación por correo no disponible. Contacta a soporte.');
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpFailure(422, 'Correo inválido');
  const email = normalizedEmail(parsed.data.email);
  const withinBudget=await allowRecoveryEmail(email);
  if(!withinBudget){res.status(202).json({message:RESET_GENERIC_REPLY});return;}
  const user = await db.authUser.findUnique({where:{email}});
  if (user?.isActive && user.passwordHash) {
    const raw = randomBytes(40).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_MINUTES*60_000);
    // Token is never stored in plaintext outside the pending email envelope.
    // A reset request never changes a password or revokes an existing session.
    await db.$transaction(async tx => {
      await tx.authPasswordResetToken.create({
        data:{userId:user.id,tokenHash:sha256Hex(raw),expiresAt},
      });
      await tx.authEmailOutbox.create({
        data:{
          toEmail:user.email,subject:'Restablece tu contraseña de Tala Eats',
          textBody:'Hola '+user.name+',\n\nRecibimos una solicitud para cambiar tu contraseña. '+
            'Abre este enlace antes de '+RESET_MINUTES+' minutos:\n\n'+
            RESET_BROWSER_URL+'?token='+encodeURIComponent(raw)+
            '\n\nSi no fuiste tú, ignora este mensaje.',
        },
      });
      await tx.authAuditEvent.create({
        data:{userId:user.id,action:'password.reset.request',
          entityType:'user',entityId:String(user.id)},
      });
    });
  }
  // Identical response for existing/unknown/disabled/Google-only accounts.
  res.status(202).json({message:RESET_GENERIC_REPLY});
});
async function completePasswordReset(rawToken:string,password:string):Promise<void>{
  const tokenHash=sha256Hex(rawToken);
  const now = new Date();
  const hashedPassword = await hashPassword(password);
  await db.$transaction(async tx => {
    const record = await tx.authPasswordResetToken.findUnique({where:{tokenHash}});
    if (!record || record.usedAt !== null || record.expiresAt <= now) {
      throw new HttpFailure(400, RESET_INVALID_REPLY);
    }
    // Conditional UPDATE obtains a row lock: only one racing reset succeeds.
    const consumed = await tx.authPasswordResetToken.updateMany({
      where:{id:record.id,usedAt:null,expiresAt:{gt:now}},
      data:{usedAt:now},
    });
    if (consumed.count !== 1) throw new HttpFailure(400, RESET_INVALID_REPLY);
    const user = await tx.authUser.findUnique({where:{id:record.userId}});
    if (!user?.isActive) throw new HttpFailure(400, 'La cuenta ya no está disponible');
    await tx.authUser.update({
      where:{id:user.id},
      data:{
        passwordHash:hashedPassword,
        ...(user.authProvider === 'google' ? {authProvider:'local+google'} : {}),
      },
    });
    // Prevent stolen older links and any previously issued JWT from working.
    await tx.authPasswordResetToken.updateMany({
      where:{userId:user.id,usedAt:null},data:{usedAt:now},
    });
    await tx.authDeviceSession.updateMany({
      where:{userId:user.id,active:true},data:{active:false,trusted:false},
    });
    await tx.authAuditEvent.create({
      data:{userId:user.id,action:'password.reset.complete',
        entityType:'user',entityId:String(user.id)},
    });
    await tx.authNotification.create({
      data:{userId:user.id,kind:'security',title:'Contraseña actualizada',
        message:'Tu contraseña de Tala Eats fue cambiada correctamente.'},
    });
  });
}
authRouter.post('/password/reset', async (req,res) => {
 await rateLimit(req,'password-reset');
 const parsed=resetSchema.safeParse(req.body);
 if(!parsed.success)throw new HttpFailure(422,'Datos de recuperación inválidos');
 await completePasswordReset(parsed.data.token,parsed.data.password);
 res.json({message:'Contraseña actualizada. Ya puedes iniciar sesión.'});
});
// Same secure server-hosted reset form for Customer, Restaurant and Driver.
// A browser is a reliable fallback when Android App Links are unavailable.
function browserHeaders(res:Response):void{
 res.setHeader('Cache-Control','no-store, max-age=0');
 res.setHeader('Pragma','no-cache');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}
const safeToken=(v:unknown):v is string=>typeof v==='string'&&
 /^[A-Za-z0-9_-]{40,150}$/.test(v);
function resetPage(token:string|null,notice:string|null,success=false):string{
 const form=success?'':token?
  '<form method="post" action="/api/v1/auth/password/reset-page">'+
  '<input type="hidden" name="token" value="'+token+'">'+
  '<label for="password">Nueva contraseña (mínimo 8 caracteres)</label>'+
  '<input id="password" type="password" name="password" autocomplete="new-password" minlength="8" maxlength="128" required>'+
  '<label for="confirm">Confirmar nueva contraseña</label>'+
  '<input id="confirm" type="password" name="confirm" autocomplete="new-password" minlength="8" maxlength="128" required>'+
  '<button type="submit">Actualizar contraseña</button></form>':
  '<p>Solicita un enlace nuevo desde Tala Eats.</p>';
 const message=notice?'<p role="alert">'+notice+'</p>':'';
 return '<!doctype html><html lang="es"><head><meta charset="utf-8">'+
  '<meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<title>Recuperar contraseña | Tala Eats</title>'+
  '<style>*{box-sizing:border-box}body{margin:0;padding:24px;min-height:100svh;display:grid;place-items:center;'+
  'background:#faf9f7;font:16px system-ui,-apple-system,sans-serif;color:#191919}main{max-width:440px;width:100%;'+
  'padding:32px;background:#fff;border:1px solid #eee;border-radius:22px;box-shadow:0 10px 35px #0000000a}'+
  'h1{font-size:26px;line-height:1.2;margin:0 0 24px}label{display:block;margin:16px 0 6px}'+
  'input{width:100%;padding:14px;border:1px solid #bbb;border-radius:10px;font:inherit}'+
  'button{margin-top:24px;background:#ef7928;border:0;border-radius:12px;padding:15px;width:100%;font:inherit;'+
  'font-weight:700;color:white;cursor:pointer}p{line-height:1.6}.brand{font-weight:700;color:#ef7928}</style></head><body>'+
  '<main><p class="brand">Tala Eats</p><h1>'+(success?'Contraseña actualizada':'Recupera tu cuenta')+
  '</h1>'+message+form+'</main></body></html>';
}
authRouter.get('/password/reset-page',(req,res)=>{
 browserHeaders(res);
 const token=req.query.token;
 if(!safeToken(token)){
  res.status(400).type('html').send(resetPage(null,'El enlace es inválido o expiró.'));return;
 }
 res.type('html').send(resetPage(token,null));
});
authRouter.post('/password/reset-page',urlencoded({extended:false,limit:'2kb'}),async(req,res)=>{
 browserHeaders(res);
 await rateLimit(req,'password-reset');
 const parsed=resetSchema.safeParse({token:req.body?.token,password:req.body?.password});
 if(!parsed.success||typeof req.body?.confirm!=='string'||
    parsed.data.password!==req.body.confirm){
  res.status(422).type('html').send(resetPage(null,'Las contraseñas no coinciden o el enlace no es válido.'));return;
 }
 try{
  await completePasswordReset(parsed.data.token,parsed.data.password);
  res.type('html').send(resetPage(null,'Ya puedes iniciar sesión en cualquiera de las tres aplicaciones.',true));
 }catch(err){
  if(err instanceof HttpFailure&&err.code===400){
   res.status(400).type('html').send(resetPage(null,'El enlace es inválido, venció o ya fue utilizado.'));return;
  }
  throw err;
 }
});

authRouter.use((error:unknown, _req:Request, res:Response, _next:NextFunction)=>{
  if (error instanceof HttpFailure) {
    res.status(error.code).json({detail:error.message});
    return;
  }
  console.error('NODE_AUTH_STAGE_ERROR',error instanceof Error ? error.name : 'unknown');
  res.status(503).json({detail:'Servicio de autenticación temporalmente no disponible'});
});
