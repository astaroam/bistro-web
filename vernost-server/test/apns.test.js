import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { testConfig, testCerts } from './helpers.js';
import { createApns } from '../src/apns.js';

test('APNs: HTTP/2 požadavek s klientským certifikátem, topic a prázdným tělem', async () => {
  const c = testCerts();
  const seen = [];
  // Testovací „Apple“ server: používá stejný certifikát a vyžaduje klientský certifikát.
  const server = http2.createSecureServer({ key: c.signerKey, cert: c.signerCert, ca: c.wwdr, requestCert: true, rejectUnauthorized: true });
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (d) => { body += d; });
    stream.on('end', () => {
      seen.push({ path: headers[':path'], topic: headers['apns-topic'], body });
      const gone = headers[':path'].endsWith('/gone');
      stream.respond({ ':status': gone ? 410 : 200 });
      stream.end(gone ? JSON.stringify({ reason: 'Unregistered' }) : '');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = testConfig();
  // certifikát serveru je vydaný na „Test Pass“, proto se připojujeme na localhost bez kontroly jména
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const apns = createApns({ ...cfg, apple: { ...cfg.apple, apnsHost: `https://127.0.0.1:${server.address().port}`, apnsCa: c.wwdr } }, { log: { error() {}, warn() {} } });
  const res = await apns.push(['abc', 'gone', 'abc']);
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  apns.close();
  server.close();
  assert.deepEqual(res.map((r) => r.status), [200, 410]);
  assert.equal(res[1].reason, 'Unregistered');
  assert.equal(seen.length, 2, 'duplicitní token se posílá jen jednou');
  assert.equal(seen[0].path, '/3/device/abc');
  assert.equal(seen[0].topic, 'pass.cz.ebistro.vernost');
  assert.equal(seen[0].body, '{}');
});
