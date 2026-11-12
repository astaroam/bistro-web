import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { memoryDb, testConfig } from './helpers.js';
import { createApp } from '../src/app.js';
import { hashPin } from '../src/auth.js';
import { createNotifier } from '../src/notifier.js';

async function setup() {
  const db = await memoryDb();
  const cfg = testConfig();
  const pushed = [];
  const apns = { push: async (tokens) => { pushed.push(...tokens); return tokens.map((t) => ({ token: t, status: t === 'gone' ? 410 : 200 })); } };
  const notify = createNotifier({ db, apns, log: { error() {}, warn() {} } });
  const app = createApp({ db, cfg, notify, log: { error: console.error, warn() {} } });
  await db.query('INSERT INTO staff (name, pin_hash) VALUES ($1, $2)', ['Petra', hashPin('1234')]);
  return { db, cfg, app, pushed, notify };
}

function unzip(buf) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pkpass-'));
  writeFileSync(path.join(dir, 'karta.pkpass'), buf);
  execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', path.join(dir, 'karta.pkpass'), dir]);
  return dir;
}

test('vydání karty do Apple Wallet vrátí podepsaný .pkpass', async () => {
  const { app, db } = await setup();
  const res = await request(app).get('/karta/apple').buffer(true).parse((r, cb) => {
    const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.apple.pkpass');
  const dir = unzip(res.body);
  for (const f of ['pass.json', 'manifest.json', 'signature', 'icon@3x.png', 'logo@3x.png', 'strip@3x.png']) {
    assert.ok(existsSync(path.join(dir, f)), `chybí ${f}`);
  }
  const pass = JSON.parse(readFileSync(path.join(dir, 'pass.json'), 'utf8'));
  const { rows } = await db.query('SELECT * FROM cards');
  assert.equal(rows.length, 1);
  assert.equal(pass.serialNumber, rows[0].serial);
  assert.equal(pass.barcodes[0].message, rows[0].code);
  assert.equal(pass.storeCard.headerFields[0].value, '0 / 8');
});

test('webová služba Apple: registrace, změny, stažení, odhlášení', async () => {
  const { app, db, pushed, notify } = await setup();
  await request(app).get('/karta/apple');
  const card = (await db.query('SELECT * FROM cards')).rows[0];
  const base = `/wallet/v1/devices/dev1/registrations/pass.cz.ebistro.vernost/${card.serial}`;
  const auth = { Authorization: `ApplePass ${card.auth_token}` };

  assert.equal((await request(app).post(base).send({ pushToken: 'tok1' })).status, 401);
  assert.equal((await request(app).post(base).set(auth).send({ pushToken: 'tok1' })).status, 201);
  assert.equal((await request(app).post(base).set(auth).send({ pushToken: 'tok1' })).status, 200);

  const list = await request(app).get('/wallet/v1/devices/dev1/registrations/pass.cz.ebistro.vernost?passesUpdatedSince=0');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.serialNumbers, [card.serial]);
  const tag = list.body.lastUpdated;
  assert.equal((await request(app).get(`/wallet/v1/devices/dev1/registrations/pass.cz.ebistro.vernost?passesUpdatedSince=${tag}`)).status, 204);

  // personál přičte misku → signál do iPhonu
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/staff/login').send({ pin: '1234' })).status, 200);
  const st = await agent.post(`/api/cards/${card.code}/stamp`).send({ amount: 1 });
  assert.equal(st.status, 200);
  assert.equal(st.body.card.stamps, 1);
  await notify.idle();
  assert.deepEqual(pushed, ['tok1']);

  const changed = await request(app).get(`/wallet/v1/devices/dev1/registrations/pass.cz.ebistro.vernost?passesUpdatedSince=${tag}`);
  assert.deepEqual(changed.body.serialNumbers, [card.serial]);

  const passUrl = `/wallet/v1/passes/pass.cz.ebistro.vernost/${card.serial}`;
  const p = await request(app).get(passUrl).set(auth);
  assert.equal(p.status, 200);
  assert.ok(p.headers['last-modified']);
  assert.equal((await request(app).get(passUrl).set(auth).set('If-Modified-Since', p.headers['last-modified'])).status, 304);
  assert.equal((await request(app).get(passUrl)).status, 401);

  assert.equal((await request(app).delete(base).set(auth)).status, 200);
  assert.equal((await db.query('SELECT * FROM registrations')).rows.length, 0);
  assert.equal((await request(app).post('/wallet/v1/log').send({ logs: ['test'] })).status, 200);
});

test('zařízení, které kartu smazalo (410), se odregistruje', async () => {
  const { app, db, notify } = await setup();
  await request(app).get('/karta/apple');
  const card = (await db.query('SELECT * FROM cards')).rows[0];
  await db.query('INSERT INTO registrations (device_id, serial, push_token) VALUES ($1, $2, $3)', ['d', card.serial, 'gone']);
  const agent = request.agent(app);
  await agent.post('/api/staff/login').send({ pin: '1234' });
  await agent.post(`/api/cards/${card.code}/stamp`).send({ amount: 1 });
  await notify.idle();
  assert.equal((await db.query('SELECT * FROM registrations')).rows.length, 0);
});

test('Kasa: přihlášení, sken, dvojitý sken, uplatnění, vrácení', async () => {
  const { app, db } = await setup();
  await request(app).get('/karta/apple');
  const { code } = (await db.query('SELECT * FROM cards')).rows[0];
  const agent = request.agent(app);

  assert.equal((await agent.get(`/api/cards/${code}`)).status, 401);
  assert.equal((await agent.post('/api/staff/login').send({ pin: '0000' })).status, 401);
  assert.equal((await agent.post('/api/staff/login').send({ pin: '1234' })).body.name, 'Petra');
  assert.equal((await agent.get(`/api/cards/${code.toLowerCase()}`)).body.code, code);

  assert.equal((await agent.post(`/api/cards/${code}/stamp`).send({ amount: 3 })).status, 200);
  const again = await agent.post(`/api/cards/${code}/stamp`).send({ amount: 3 });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'RECENT_STAMP');
  await agent.post(`/api/cards/${code}/stamp`).send({ amount: 3, confirm: true });
  const notFull = await agent.post(`/api/cards/${code}/redeem`).send({});
  assert.equal(notFull.status, 409);
  const last = await agent.post(`/api/cards/${code}/stamp`).send({ amount: 2, confirm: true });
  assert.equal(last.body.card.full, true);
  const red = await agent.post(`/api/cards/${code}/redeem`).send({});
  assert.equal(red.status, 200);
  assert.equal(red.body.card.stamps, 0);
  const undo = await agent.post(`/api/events/${red.body.eventId}/undo`).send({});
  assert.equal(undo.body.card.stamps, 8);

  const events = await agent.get('/api/events');
  assert.ok(events.body.length >= 4);
  assert.equal(events.body[0].staff_name, 'Petra');

  // zápis bez JSON (např. podvržený formulář) je odmítnut
  assert.equal((await agent.post(`/api/cards/${code}/stamp`).type('form').send('amount=1')).status, 415);
});

test('administrace: heslo, statistiky, hromadná zpráva, personál', async () => {
  const { app } = await setup();
  await request(app).get('/karta/apple');
  const admin = request.agent(app);
  assert.equal((await admin.post('/api/admin/login').send({ password: 'spatne' })).status, 401);
  assert.equal((await admin.post('/api/admin/login').send({ password: 'tajne-heslo' })).status, 200);
  const stats = await admin.get('/api/admin/stats');
  assert.equal(stats.body.cards, 1);
  assert.equal(stats.body.goal, 8);
  assert.equal((await admin.post('/api/admin/broadcast').send({ text: 'Zítra zavřeno, státní svátek.' })).body.sent, 1);
  assert.equal((await admin.get('/api/admin/broadcasts')).body[0].sent_count, 1);
  assert.equal((await admin.post('/api/admin/staff').send({ name: 'Honza', pin: '1234' })).status, 400, 'PIN už používá Petra');
  assert.equal((await admin.post('/api/admin/staff').send({ name: 'Honza', pin: '5678' })).status, 200);
  assert.equal((await admin.get('/api/admin/staff')).body.length, 2);
  assert.equal((await admin.post('/api/admin/settings').send({ welcomeStamps: 1 })).status, 200);
  await request(app).get('/karta/apple');
  assert.equal((await admin.get('/api/admin/stats')).body.welcomeStamps, 1);

  const staff = request.agent(app);
  await staff.post('/api/staff/login').send({ pin: '5678' });
  assert.equal((await staff.get('/api/admin/stats')).status, 401, 'personál nevidí administraci');
});

test('bez certifikátu Apple stránka slušně odpoví, že karta zatím není', async () => {
  const db = await memoryDb();
  const cfg = testConfig();
  const app = createApp({ db, cfg: { ...cfg, apple: { ...cfg.apple, signerCert: undefined } } });
  const res = await request(app).get('/karta/apple');
  assert.equal(res.status, 503);
  assert.match(res.text, /spustíme už brzy/);
  assert.equal((await request(app).get('/karta/google')).status, 503);
});
