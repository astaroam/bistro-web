import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, testConfig } from './helpers.js';
import { createCards, normalizeCode, newCode } from '../src/cards.js';
import { buildPassJson, headerMessage } from '../src/pass.js';

async function setup() {
  const db = await memoryDb();
  const calls = [];
  const cards = createCards({ db, cfg: testConfig(), notify: async (s, r) => calls.push([s, r]) });
  return { db, cards, calls };
}

test('kód karty jde přepsat rukou a normalizovat', () => {
  const code = newCode();
  assert.match(code, /^EB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(normalizeCode(code.toLowerCase().replace(/-/g, ' ')), code);
  assert.equal(normalizeCode('nesmysl'), null);
});

test('vydání karty, přičtení misek a uplatnění odměny', async () => {
  const { cards, calls } = await setup();
  const card = await cards.issueCard({ platform: 'apple' });
  assert.equal(card.stamps, 0);

  let r = await cards.stamp({ code: card.code, amount: 3, staffId: 1 });
  assert.equal(r.card.stamps, 3);
  assert.deepEqual(calls.at(-1), [[card.serial], 'stamp']);

  // druhý sken do 10 minut chce potvrzení
  await assert.rejects(cards.stamp({ code: card.code, amount: 1, staffId: 1 }), { code: 'RECENT_STAMP' });
  r = await cards.stamp({ code: card.code, amount: 3, staffId: 1, confirm: true });
  r = await cards.stamp({ code: card.code, amount: 3, staffId: 1, confirm: true });
  assert.equal(r.card.stamps, 9);
  assert.equal(cards.view(r.card).full, true);
  assert.equal(cards.view(r.card).shown, 8);

  r = await cards.redeem({ code: card.code, staffId: 1 });
  assert.equal(r.card.stamps, 1, 'přebytečná miska se převede');
  assert.equal(r.card.rewards_redeemed, 1);
  await assert.rejects(cards.redeem({ code: card.code, staffId: 1 }), { code: 'NOT_FULL' });
});

test('vrácení posledního kroku', async () => {
  const { cards } = await setup();
  const card = await cards.issueCard({ platform: 'apple' });
  const { event } = await cards.stamp({ code: card.code, amount: 2, staffId: 7 });
  await assert.rejects(cards.undo({ eventId: event.id, staffId: 8 }), { code: 'CANNOT_UNDO' });
  const { card: after } = await cards.undo({ eventId: event.id, staffId: 7 });
  assert.equal(after.stamps, 0);
  await assert.rejects(cards.undo({ eventId: event.id, staffId: 7 }), { code: 'CANNOT_UNDO' });
});

test('neplatné množství a neexistující karta', async () => {
  const { cards } = await setup();
  const card = await cards.issueCard({ platform: 'google' });
  await assert.rejects(cards.stamp({ code: card.code, amount: 4 }), { code: 'BAD_AMOUNT' });
  await assert.rejects(cards.stamp({ code: 'EB-2222-2222' }), { code: 'NOT_FOUND' });
});

test('hromadná zpráva změní pole Novinka u všech karet', async () => {
  const { cards, calls } = await setup();
  const a = await cards.issueCard({ platform: 'apple' });
  await cards.issueCard({ platform: 'google' });
  assert.equal(await cards.broadcast('Dnes vaříme Pho Bo.'), 2);
  assert.equal((await cards.getByCode(a.code)).news, 'Dnes vaříme Pho Bo.');
  assert.equal(calls.at(-1)[0].length, 2);
  await assert.rejects(cards.broadcast('x'), { code: 'BAD_TEXT' });
});

test('pass.json: barvy, QR, webová služba a texty oznámení', () => {
  const cfg = testConfig();
  const json = buildPassJson({ serial: 's1', code: 'EB-ABCD-EFGH', auth_token: 't'.repeat(48), stamps: 7, rewards_redeemed: 0, news: 'Novinka!' }, cfg);
  assert.equal(json.passTypeIdentifier, 'pass.cz.ebistro.vernost');
  assert.equal(json.webServiceURL, 'https://karta.example.test/wallet');
  assert.equal(json.labelColor, 'rgb(247, 206, 27)');
  assert.equal(json.barcodes[0].message, 'EB-ABCD-EFGH');
  assert.equal(json.storeCard.headerFields[0].value, '7 / 8');
  assert.match(json.storeCard.headerFields[0].changeMessage, /Poslední miska/);
  assert.equal(json.storeCard.backFields[0].key, 'news');
  assert.equal(headerMessage(8, 8, 0), 'Máte jídlo zdarma! Ukažte kartu na kase.');
  assert.equal(headerMessage(0, 8, 1), 'Dobrou chuť! Karta začíná znovu od nuly.');
  assert.match(headerMessage(3, 8, 0), /%@/);
});
