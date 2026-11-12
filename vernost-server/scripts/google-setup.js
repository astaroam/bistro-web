// Založí nebo aktualizuje třídu věrnostní karty v Google Peněžence: `node scripts/google-setup.js`
// Spustit jednou po vyplnění GOOGLE_ISSUER_ID a GOOGLE_SERVICE_ACCOUNT_JSON.
import { loadConfig, googleReady } from '../src/config.js';
import { createGoogleWallet } from '../src/google.js';

const cfg = loadConfig();
if (!googleReady(cfg)) {
  console.error('Chybí GOOGLE_ISSUER_ID nebo GOOGLE_SERVICE_ACCOUNT_JSON.');
  process.exit(1);
}
const res = await createGoogleWallet(cfg).ensureClass();
console.log('Třída karty je připravená:', res?.id, res?.reviewStatus);
