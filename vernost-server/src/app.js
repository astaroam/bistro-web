// HTTP server: vydání karet, webová služba Apple Wallet, API pro Kasu a administraci.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { appleReady, googleReady } from './config.js';
import { createCards, CardError, normalizeCode } from './cards.js';
import { buildPkpass } from './pass.js';
import { createSessions, checkPin, hashPin, safeEqual, rateLimiter } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

export function createApp({ db, cfg, notify = async () => {}, google = null, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const cards = createCards({ db, cfg, notify });
  const sessions = createSessions(cfg.sessionSecret, { secure: cfg.cookieSecure ?? cfg.publicUrl.startsWith('https://') });
  const issueLimit = rateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
  const loginLimit = rateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/health', (req, res) => res.json({ ok: true, apple: appleReady(cfg), google: googleReady(cfg) && Boolean(google) }));

  // ---------- Vydání karty (odkazy ze stránky e-bistro.cz/vernost) ----------

  function unavailable(res, what) {
    res.status(503).type('html').send(page('Karta zatím není k dispozici', `<p>${what} spustíme už brzy. Zkuste to prosím později.</p>`));
  }

  app.get('/karta/apple', wrap(async (req, res) => {
    if (!appleReady(cfg)) return unavailable(res, 'Kartu do Apple Wallet');
    if (issueLimit(req.ip)) return res.status(429).type('html').send(page('Příliš mnoho pokusů', '<p>Zkuste to prosím za chvíli.</p>'));
    const card = await cards.issueCard({ platform: 'apple' });
    const buf = buildPkpass(card, cfg);
    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="ebistro-vernostni-karta.pkpass"',
      'Last-Modified': new Date(Number(card.updated_ms)).toUTCString(),
      'Cache-Control': 'no-store',
    });
    res.send(buf);
  }));

  app.get('/karta/google', wrap(async (req, res) => {
    if (!google) return unavailable(res, 'Kartu do Google Peněženky');
    if (issueLimit(req.ip)) return res.status(429).type('html').send(page('Příliš mnoho pokusů', '<p>Zkuste to prosím za chvíli.</p>'));
    const card = await cards.issueCard({ platform: 'google' });
    res.redirect(302, google.saveUrl(card));
  }));

  // ---------- Webová služba Apple Wallet (volá ji iPhone) ----------
  // https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes

  const wallet = express.Router();
  wallet.use(express.json({ limit: '100kb' }));

  async function authorizedCard(req) {
    if (req.params.passTypeId !== cfg.apple.passTypeId) return { status: 404 };
    const card = await cards.getBySerial(req.params.serial);
    const header = req.get('Authorization') || '';
    const token = header.startsWith('ApplePass ') ? header.slice(10) : '';
    if (!card || !safeEqual(token, card.auth_token)) return { status: 401 };
    return { card };
  }

  wallet.post('/v1/devices/:deviceId/registrations/:passTypeId/:serial', wrap(async (req, res) => {
    const { card, status } = await authorizedCard(req);
    if (!card) return res.sendStatus(status);
    const pushToken = req.body?.pushToken;
    if (!pushToken || typeof pushToken !== 'string') return res.sendStatus(400);
    const existing = await db.query('SELECT 1 FROM registrations WHERE device_id = $1 AND serial = $2', [req.params.deviceId, card.serial]);
    if (existing.rows.length) {
      await db.query('UPDATE registrations SET push_token = $1 WHERE device_id = $2 AND serial = $3', [pushToken, req.params.deviceId, card.serial]);
      return res.sendStatus(200);
    }
    await db.query('INSERT INTO registrations (device_id, serial, push_token) VALUES ($1, $2, $3)', [req.params.deviceId, card.serial, pushToken]);
    res.sendStatus(201);
  }));

  wallet.get('/v1/devices/:deviceId/registrations/:passTypeId', wrap(async (req, res) => {
    if (req.params.passTypeId !== cfg.apple.passTypeId) return res.sendStatus(404);
    const since = Number.parseInt(req.query.passesUpdatedSince, 10) || 0;
    const { rows } = await db.query(
      `SELECT c.serial, c.updated_ms FROM registrations r JOIN cards c ON c.serial = r.serial
       WHERE r.device_id = $1 AND c.updated_ms > $2`,
      [req.params.deviceId, since],
    );
    if (!rows.length) return res.sendStatus(204);
    const lastUpdated = Math.max(...rows.map((r) => Number(r.updated_ms)));
    res.json({ serialNumbers: rows.map((r) => r.serial), lastUpdated: String(lastUpdated) });
  }));

  wallet.get('/v1/passes/:passTypeId/:serial', wrap(async (req, res) => {
    const { card, status } = await authorizedCard(req);
    if (!card) return res.sendStatus(status);
    const modifiedSec = Math.floor(Number(card.updated_ms) / 1000);
    const ims = Date.parse(req.get('If-Modified-Since') || '');
    if (!Number.isNaN(ims) && Math.floor(ims / 1000) >= modifiedSec) return res.sendStatus(304);
    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Last-Modified': new Date(modifiedSec * 1000).toUTCString(),
      'Cache-Control': 'no-store',
    });
    res.send(buildPkpass(card, cfg));
  }));

  wallet.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serial', wrap(async (req, res) => {
    const { card, status } = await authorizedCard(req);
    if (!card) return res.sendStatus(status);
    await db.query('DELETE FROM registrations WHERE device_id = $1 AND serial = $2', [req.params.deviceId, card.serial]);
    res.sendStatus(200);
  }));

  wallet.post('/v1/log', (req, res) => {
    for (const line of (req.body?.logs || []).slice(0, 20)) log.warn('Wallet log:', String(line).slice(0, 500));
    res.sendStatus(200);
  });

  app.use('/wallet', wallet);

  // ---------- API pro Kasu a administraci ----------

  const api = express.Router();
  api.use(express.json({ limit: '20kb' }));
  // Ochrana proti podvrženým formulářům z cizích stránek: zápisy jen jako JSON.
  api.use((req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Očekávám JSON.' });
    next();
  });

  const requireStaff = (req, res, next) => {
    const s = sessions.read(req);
    if (!s || !['staff', 'admin'].includes(s.role)) return res.status(401).json({ error: 'Přihlaste se.' });
    req.session = s;
    next();
  };
  const requireAdmin = (req, res, next) => {
    const s = sessions.read(req);
    if (!s || s.role !== 'admin') return res.status(401).json({ error: 'Přihlaste se jako správce.' });
    req.session = s;
    next();
  };

  api.post('/staff/login', wrap(async (req, res) => {
    if (loginLimit(req.ip)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkuste to za 15 minut.' });
    const pin = String(req.body?.pin || '');
    const { rows } = await db.query('SELECT * FROM staff WHERE active = true');
    const who = rows.find((s) => checkPin(pin, s.pin_hash));
    if (!who) return res.status(401).json({ error: 'Špatný PIN.' });
    sessions.issue(res, { role: 'staff', staffId: who.id, name: who.name }, 14);
    res.json({ name: who.name });
  }));

  api.post('/admin/login', wrap(async (req, res) => {
    if (loginLimit(req.ip)) return res.status(429).json({ error: 'Příliš mnoho pokusů, zkuste to za 15 minut.' });
    if (!cfg.adminPassword || !safeEqual(req.body?.password, cfg.adminPassword)) return res.status(401).json({ error: 'Špatné heslo.' });
    sessions.issue(res, { role: 'admin', staffId: null, name: 'Správce' }, 12);
    res.json({ name: 'Správce' });
  }));

  api.post('/logout', (req, res) => { sessions.clear(res); res.json({ ok: true }); });

  api.get('/me', requireStaff, (req, res) => res.json({ name: req.session.name, role: req.session.role, goal: cfg.stampsGoal, rewardText: cfg.rewardText }));

  api.get('/cards/:code', requireStaff, wrap(async (req, res) => {
    const card = await cards.getByCode(req.params.code);
    if (!card) return res.status(404).json({ error: 'Karta s tímto kódem neexistuje.' });
    res.json(cards.view(card));
  }));

  api.post('/cards/:code/stamp', requireStaff, wrap(async (req, res) => {
    const { card, event } = await cards.stamp({
      code: req.params.code, amount: req.body?.amount ?? 1, staffId: req.session.staffId, confirm: Boolean(req.body?.confirm),
    });
    res.json({ card: cards.view(card), eventId: event.id });
  }));

  api.post('/cards/:code/redeem', requireStaff, wrap(async (req, res) => {
    const { card, event } = await cards.redeem({ code: req.params.code, staffId: req.session.staffId });
    res.json({ card: cards.view(card), eventId: event.id });
  }));

  api.post('/events/:id/undo', requireStaff, wrap(async (req, res) => {
    const staffId = req.session.role === 'admin' ? null : req.session.staffId;
    const { card } = await cards.undo({ eventId: Number(req.params.id), staffId });
    res.json({ card: cards.view(card) });
  }));

  api.get('/events', requireStaff, wrap(async (req, res) => res.json(await cards.recentEvents(15))));

  api.get('/admin/stats', requireAdmin, wrap(async (req, res) => {
    const welcome = (await db.query("SELECT value FROM settings WHERE key = 'welcome_stamps'")).rows[0]?.value || '0';
    res.json({ ...(await cards.stats()), goal: cfg.stampsGoal, welcomeStamps: Number(welcome), apple: appleReady(cfg), google: Boolean(google) });
  }));

  api.post('/admin/broadcast', requireAdmin, wrap(async (req, res) => {
    res.json({ sent: await cards.broadcast(req.body?.text) });
  }));

  api.get('/admin/broadcasts', requireAdmin, wrap(async (req, res) => {
    res.json((await db.query('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 10')).rows);
  }));

  api.get('/admin/staff', requireAdmin, wrap(async (req, res) => {
    res.json((await db.query('SELECT id, name, active, created_at FROM staff ORDER BY id')).rows);
  }));

  api.post('/admin/staff', requireAdmin, wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const pin = String(req.body?.pin || '');
    if (!name || name.length > 40) return res.status(400).json({ error: 'Zadejte jméno.' });
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PIN musí mít 4 až 8 číslic.' });
    const { rows } = await db.query('SELECT pin_hash FROM staff WHERE active = true');
    if (rows.some((s) => checkPin(pin, s.pin_hash))) return res.status(400).json({ error: 'Tento PIN už někdo používá.' });
    const row = (await db.query('INSERT INTO staff (name, pin_hash) VALUES ($1, $2) RETURNING id, name, active', [name, hashPin(pin)])).rows[0];
    res.json(row);
  }));

  api.post('/admin/staff/:id/deactivate', requireAdmin, wrap(async (req, res) => {
    await db.query('UPDATE staff SET active = false WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  api.post('/admin/settings', requireAdmin, wrap(async (req, res) => {
    const w = Number(req.body?.welcomeStamps);
    if (!Number.isInteger(w) || w < 0 || w > 2) return res.status(400).json({ error: 'Uvítací misky: 0 až 2.' });
    await db.query("DELETE FROM settings WHERE key = 'welcome_stamps'");
    await db.query("INSERT INTO settings (key, value) VALUES ('welcome_stamps', $1)", [String(w)]);
    res.json({ welcomeStamps: w });
  }));

  app.use('/api', api);

  // ---------- Statické stránky ----------
  app.use('/assets', express.static(path.join(root, 'assets'), { maxAge: '7d', index: false }));
  app.get('/vendor/jsQR.js', (req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
  app.get('/', (req, res) => res.redirect(302, `${cfg.siteUrl}/vernost/`));

  // ---------- Chyby ----------
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof CardError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Neplatný JSON.' });
    log.error(err);
    res.status(500).json({ error: 'Něco se pokazilo. Zkuste to znovu.' });
  });

  return app;
}

function page(title, body) {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · eBISTRO</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#161616;color:#F3F1EA;font:17px/1.5 "Titillium Web",system-ui,sans-serif;text-align:center;padding:24px}h1{font-weight:300}a{color:#F7CE1B}</style></head>
<body><main><h1>${title}</h1>${body}<p><a href="https://e-bistro.cz">Zpět na e-bistro.cz</a></p></main></body></html>`;
}

export { normalizeCode };
