// Spuštění serveru: `npm start`. Nastavení viz README.md.
import { loadConfig, appleReady, googleReady } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { createApns } from './apns.js';
import { createGoogleWallet } from './google.js';
import { createNotifier } from './notifier.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
await migrate(db);

const apns = appleReady(cfg) ? createApns(cfg) : null;
const google = googleReady(cfg) ? createGoogleWallet(cfg) : null;
const notify = createNotifier({ db, apns, google });

const app = createApp({ db, cfg, notify, google });
const server = app.listen(cfg.port, () => {
  console.log(`Věrnostní server běží na portu ${cfg.port} (${cfg.publicUrl})`);
  console.log(`Apple Wallet: ${apns ? 'zapnuto' : 'chybí certifikát nebo Team ID'} · Google Peněženka: ${google ? 'zapnuto' : 'vypnuto'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    apns?.close();
    db.end().finally(() => process.exit(0));
  });
}
