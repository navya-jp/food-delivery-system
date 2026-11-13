/**
 * Password hashing (scrypt) and JWT (HS256) using only node:crypto.
 */
import crypto from 'node:crypto';

const DEV_SECRET = 'dev-only-secret-change-me';
const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s && process.env.NODE_ENV === 'production') {
    console.warn('[auth] JWT_SECRET is not set; using an insecure development secret');
  }
  return s || DEV_SECRET;
};

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export function signToken(payload, ttlMs = 24 * 3600 * 1000) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64({ ...payload, exp: Date.now() + ttlMs });
  return `${header}.${claims}.${sign(`${header}.${claims}`)}`;
}

export function verifyToken(token) {
  try {
    const [header, claims, signature] = String(token).split('.');
    if (!header || !claims || !signature) return null;
    const expected = Buffer.from(sign(`${header}.${claims}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}
