// Odeslání signálu „karta se změnila“ přes Apple Push Notification service.
// Pro karty Wallet se používá certifikát Pass Type ID, topic = Pass Type ID a prázdné tělo {}.
import http2 from 'node:http2';

export function createApns(cfg, { log = console } = {}) {
  const a = cfg.apple;
  let session = null;

  function connect() {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(a.apnsHost, {
      cert: a.signerCert,
      key: a.signerKey,
      passphrase: a.signerKeyPassphrase,
      ca: a.apnsCa, // jen pro testy; v provozu platí systémové certifikáty
    });
    session.on('error', (e) => log.error('APNs spojení selhalo:', e.message));
    session.on('goaway', () => session.close());
    session.setTimeout(10 * 60 * 1000, () => session.close());
    return session;
  }

  function pushOne(token) {
    return new Promise((resolve) => {
      let req;
      try {
        req = connect().request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          'apns-topic': a.passTypeId,
        });
      } catch (e) {
        resolve({ token, status: 0, error: e.message });
        return;
      }
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => { body += d; });
      req.on('end', () => resolve({ token, status, reason: body ? safeReason(body) : undefined }));
      req.on('error', (e) => resolve({ token, status: 0, error: e.message }));
      req.setTimeout(15000, () => { req.close(); resolve({ token, status: 0, error: 'timeout' }); });
      req.end('{}');
    });
  }

  // Vrací výsledky; tokeny se stavem 410 (zařízení kartu smazalo) volající odregistruje.
  async function push(tokens) {
    const unique = [...new Set(tokens)];
    const results = [];
    for (let i = 0; i < unique.length; i += 50) {
      results.push(...(await Promise.all(unique.slice(i, i + 50).map(pushOne))));
    }
    const failed = results.filter((r) => r.status !== 200);
    if (failed.length) log.warn(`APNs: ${failed.length} z ${results.length} signálů neprošlo`, failed.slice(0, 3));
    return results;
  }

  function close() {
    if (session) session.close();
  }

  return { push, close };
}

function safeReason(body) {
  try { return JSON.parse(body).reason; } catch { return body.slice(0, 100); }
}
