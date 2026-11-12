// Spustí server s databází v paměti a ukázkovými daty, bez Postgresu a bez certifikátů Apple.
// Na vyzkoušení Kasy a administrace: `node scripts/dev-memory.js`, pak http://localhost:3000/kasa/
// PIN personálu: 1234, heslo správce: admin. Data se po vypnutí ztratí.
import { newDb } from 'pg-mem';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createCards } from '../src/cards.js';
import { hashPin } from '../src/auth.js';

const cfg = loadConfig({ sessionSecret: 'dev-'.repeat(10), adminPassword: 'admin', cookieSecure: false });
const { Pool } = newDb().adapters.createPg();
const db = new Pool();
await migrate(db);
await db.query('INSERT INTO staff (name, pin_hash) VALUES ($1, $2)', ['Petra', hashPin('1234')]);

const cards = createCards({ db, cfg });
for (const n of [3, 7, 9]) {
  const c = await cards.issueCard({ platform: n === 7 ? 'google' : 'apple' });
  await db.query('UPDATE cards SET stamps = $1, stamps_total = $1, last_visit_at = now() WHERE serial = $2', [n, c.serial]);
  console.log(`Ukázková karta ${c.code}: ${n} misek`);
}

createApp({ db, cfg }).listen(cfg.port, () => console.log(`http://localhost:${cfg.port}/kasa/ (PIN 1234) · http://localhost:${cfg.port}/admin/ (heslo admin)`));
