// Veškeré nastavení se čte z proměnných prostředí. Popis je v README.md a .env.example.
import { readFileSync } from 'node:fs';

function fileOrValue(name) {
  // Certifikáty jde zadat buď přímo (PEM text, \n jako zalomení), nebo cestou k souboru v <NAME>_FILE.
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8');
  const v = process.env[name];
  return v ? v.replace(/\\n/g, '\n') : undefined;
}

function parseJson(text) {
  if (!text) return undefined;
  return JSON.parse(text);
}

function int(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number.parseInt(v, 10);
}

export function loadConfig(overrides = {}) {
  const cfg = {
    port: int('PORT', 3000),
    publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
    siteUrl: (process.env.SITE_URL || 'https://e-bistro.cz').replace(/\/$/, ''),
    databaseUrl: process.env.DATABASE_URL,

    // Pravidla programu
    stampsGoal: int('STAMPS_GOAL', 8),
    rewardText: process.env.REWARD_TEXT || 'Jídlo zdarma',
    rewardDetail: process.env.REWARD_DETAIL || 'libovolné hlavní jídlo z nabídky',
    maxStampsPerScan: 3,
    rescanWindowMinutes: int('RESCAN_WINDOW_MINUTES', 10),
    undoWindowMinutes: 2,

    // Přístupy
    sessionSecret: process.env.SESSION_SECRET,
    adminPassword: process.env.ADMIN_PASSWORD,

    // Apple Wallet
    apple: {
      passTypeId: process.env.APPLE_PASS_TYPE_ID || 'pass.cz.ebistro.vernost',
      teamId: process.env.APPLE_TEAM_ID,
      signerCert: fileOrValue('APPLE_PASS_CERT'),
      signerKey: fileOrValue('APPLE_PASS_KEY'),
      signerKeyPassphrase: process.env.APPLE_PASS_KEY_PASSPHRASE,
      wwdr: fileOrValue('APPLE_WWDR_CERT'),
      apnsHost: process.env.APNS_HOST || 'https://api.push.apple.com',
    },

    // Google Peněženka (nepovinné, zapne se vyplněním)
    google: {
      issuerId: process.env.GOOGLE_ISSUER_ID,
      serviceAccount: parseJson(fileOrValue('GOOGLE_SERVICE_ACCOUNT_JSON')),
      classSuffix: process.env.GOOGLE_CLASS_SUFFIX || 'vernost',
    },

    // Texty na zadní straně karty
    venue: {
      name: 'eBISTRO',
      hours: process.env.VENUE_HOURS || 'Po–Pá 11:00–14:00 · rozvoz 9:00–10:45',
      address: process.env.VENUE_ADDRESS || 'Hlavní třída 107, 738 01 Frýdek-Místek',
      phone: process.env.VENUE_PHONE || '+420 736 727 978',
      orderUrl: process.env.VENUE_ORDER_URL || 'https://ebistro.sebou.cz',
    },
    ...overrides,
  };

  if (!(cfg.stampsGoal >= 5 && cfg.stampsGoal <= 10)) {
    throw new Error('STAMPS_GOAL musí být 5 až 10 (obrázky misek jsou připravené jen pro tento rozsah).');
  }
  return cfg;
}

export function appleReady(cfg) {
  const a = cfg.apple;
  return Boolean(a.teamId && a.signerCert && a.signerKey && a.wwdr);
}

export function googleReady(cfg) {
  return Boolean(cfg.google.issuerId && cfg.google.serviceAccount);
}
