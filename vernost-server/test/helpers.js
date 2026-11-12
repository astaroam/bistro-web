import { newDb } from 'pg-mem';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db.js';

export async function memoryDb() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  return pool;
}

// Testovací certifikáty podepsané vlastní „falešnou Apple“ autoritou. iPhone by je nepřijal,
// ale ověří, že se karta správně sestaví a podepíše.
let certs;
export function testCerts() {
  if (certs) return certs;
  const dir = mkdtempSync(path.join(tmpdir(), 'ebistro-certs-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test WWDR');
  run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'pass.key', '-out', 'pass.csr', '-subj', '/CN=Test Pass');
  run('x509', '-req', '-in', 'pass.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'pass.pem', '-days', '2');
  const read = (f) => readFileSync(path.join(dir, f), 'utf8');
  certs = { wwdr: read('ca.pem'), signerCert: read('pass.pem'), signerKey: read('pass.key') };
  return certs;
}

export function testConfig(overrides = {}) {
  const c = testCerts();
  const base = loadConfig();
  return {
    ...base,
    publicUrl: 'https://karta.example.test',
    sessionSecret: 'x'.repeat(40),
    adminPassword: 'tajne-heslo',
    cookieSecure: false, // supertest jede přes http
    stampsGoal: 8,
    apple: { ...base.apple, teamId: 'ABCDE12345', ...c },
    ...overrides,
  };
}
