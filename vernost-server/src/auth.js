// Přihlášení personálu (PIN) a administrace (heslo). Podepsaná cookie, bez uložených relací.
import crypto from 'node:crypto';

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function checkPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createSessions(secret, { secure }) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET musí mít aspoň 32 znaků.');
  const NAME = 'ebs';
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function issue(res, session, hours) {
    const data = Buffer.from(JSON.stringify({ ...session, exp: Date.now() + hours * 3600_000 })).toString('base64url');
    res.cookie(NAME, `${data}.${sign(data)}`, {
      httpOnly: true, sameSite: 'strict', secure, maxAge: hours * 3600_000, path: '/',
    });
  }

  function read(req) {
    const raw = parseCookies(req.headers.cookie)[NAME];
    if (!raw) return null;
    const [data, sig] = raw.split('.');
    if (!data || !sig || !safeEqual(sig, sign(data))) return null;
    try {
      const s = JSON.parse(Buffer.from(data, 'base64url').toString());
      return s.exp > Date.now() ? s : null;
    } catch {
      return null;
    }
  }

  function clear(res) {
    res.clearCookie(NAME, { path: '/' });
  }

  return { issue, read, clear };
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

// Jednoduchý limit pokusů v paměti (stačí pro jeden server).
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10000) hits.clear();
    return list.length > max;
  };
}
