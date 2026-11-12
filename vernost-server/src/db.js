// Připojení k Postgresu a založení tabulek. Testy sem podstrčí databázi v paměti (pg-mem).
import pg from 'pg';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  serial            TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  auth_token        TEXT NOT NULL,
  platform          TEXT NOT NULL,
  stamps            INTEGER NOT NULL DEFAULT 0,
  stamps_total      INTEGER NOT NULL DEFAULT 0,
  rewards_redeemed  INTEGER NOT NULL DEFAULT 0,
  news              TEXT,
  email             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_visit_at     TIMESTAMPTZ,
  updated_ms        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  device_id   TEXT NOT NULL,
  serial      TEXT NOT NULL REFERENCES cards(serial) ON DELETE CASCADE,
  push_token  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, serial)
);

CREATE TABLE IF NOT EXISTS staff (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  pin_hash  TEXT NOT NULL,
  active    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  serial      TEXT NOT NULL REFERENCES cards(serial) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  amount      INTEGER NOT NULL DEFAULT 0,
  staff_id    INTEGER,
  undone      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id          SERIAL PRIMARY KEY,
  text        TEXT NOT NULL,
  sent_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_serial_idx ON events(serial);
CREATE INDEX IF NOT EXISTS registrations_serial_idx ON registrations(serial);
`;

export function createPool(databaseUrl) {
  if (!databaseUrl) throw new Error('Chybí DATABASE_URL.');
  const ssl = /sslmode=require|render\.com|railway|neon\.tech|supabase/.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : undefined;
  return new pg.Pool({ connectionString: databaseUrl, ssl, max: 5 });
}

export async function migrate(pool) {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
}
