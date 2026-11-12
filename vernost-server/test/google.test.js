import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { testConfig, testCerts } from './helpers.js';
import { createGoogleWallet } from '../src/google.js';

test('Google: odkaz „Uložit“ nese podepsané JWT s kartou', () => {
  const { signerKey } = testCerts();
  const cfg = testConfig({
    siteUrl: 'https://e-bistro.cz',
    google: { issuerId: '3388000000012345678', classSuffix: 'vernost', serviceAccount: { client_email: 'wallet@ebistro.iam.gserviceaccount.com', private_key: signerKey } },
  });
  const g = createGoogleWallet(cfg);
  const card = { serial: 'abc-123', code: 'EB-ABCD-EFGH', stamps: 9, rewards_redeemed: 0 };
  const url = g.saveUrl(card);
  assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  const [h, b, s] = url.split('/').pop().split('.');
  const pub = crypto.createPublicKey(signerKey);
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(pub, Buffer.from(s, 'base64url')));
  const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.equal(payload.typ, 'savetowallet');
  assert.deepEqual(payload.origins, ['https://e-bistro.cz']);
  const obj = payload.payload.loyaltyObjects[0];
  assert.equal(obj.id, '3388000000012345678.abc-123');
  assert.equal(obj.classId, '3388000000012345678.vernost');
  assert.equal(obj.loyaltyPoints.balance.string, '8 / 8');
  assert.equal(obj.barcode.value, 'EB-ABCD-EFGH');
  assert.match(obj.heroImage.sourceUri.uri, /strips\/8\/strip-8@3x\.png$/);
});
