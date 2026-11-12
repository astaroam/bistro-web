// Přidá člena personálu z příkazové řádky: `node scripts/add-staff.js "Petra" 1234`
// Běžně se personál přidává v administraci, tohle je pro první spuštění.
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { hashPin } from '../src/auth.js';

const [name, pin] = process.argv.slice(2);
if (!name || !/^\d{4,8}$/.test(pin || '')) {
  console.error('Použití: node scripts/add-staff.js "Jméno" PIN (4 až 8 číslic)');
  process.exit(1);
}
const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
await migrate(db);
const { rows } = await db.query('INSERT INTO staff (name, pin_hash) VALUES ($1, $2) RETURNING id', [name, hashPin(pin)]);
console.log(`Přidáno: ${name} (id ${rows[0].id})`);
await db.end();
