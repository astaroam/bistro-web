// Sestavení a podpis karty .pkpass pro Apple Wallet.
import { PKPass } from 'passkit-generator';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const cache = new Map();
function asset(...p) {
  const file = path.join(assets, ...p);
  if (!cache.has(file)) cache.set(file, readFileSync(file));
  return cache.get(file);
}

function misek(n) {
  if (n === 1) return '1 miska';
  if (n >= 2 && n <= 4) return `${n} misky`;
  return `${n} misek`;
}

export function headerMessage(stamps, goal, rewardsRedeemed) {
  if (stamps >= goal) return 'Máte jídlo zdarma! Ukažte kartu na kase.';
  if (stamps === goal - 1) return 'Poslední miska chybí. Příště je jídlo na nás. (%@)';
  if (stamps === 0 && rewardsRedeemed > 0) return 'Dobrou chuť! Karta začíná znovu od nuly.';
  return 'Díky za návštěvu! Stav karty: %@';
}

// Čistá funkce: z karty a nastavení udělá obsah pass.json. Testuje se zvlášť.
export function buildPassJson(card, cfg) {
  const goal = cfg.stampsGoal;
  const stamps = Number(card.stamps);
  const full = stamps >= goal;
  const left = Math.max(goal - stamps, 0);
  const v = cfg.venue;

  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.apple.passTypeId,
    teamIdentifier: cfg.apple.teamId,
    serialNumber: card.serial,
    organizationName: v.name,
    description: `${v.name} věrnostní karta`,
    authenticationToken: card.auth_token,
    webServiceURL: `${cfg.publicUrl}/wallet`,
    backgroundColor: 'rgb(22, 22, 22)',
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(247, 206, 27)',
    sharingProhibited: true,
    barcodes: [{ format: 'PKBarcodeFormatQR', message: card.code, messageEncoding: 'iso-8859-1', altText: card.code }],
    storeCard: {
      headerFields: [{
        key: 'stamps',
        label: 'MISKY',
        value: `${Math.min(stamps, goal)} / ${goal}`,
        // iPhone ukáže oznámení jen u pole, které se změnilo. Text vybíráme podle nového stavu.
        changeMessage: headerMessage(stamps, goal, Number(card.rewards_redeemed)),
      }],
      secondaryFields: [
        { key: 'reward', label: 'ODMĚNA', value: cfg.rewardText },
        full
          ? { key: 'left', label: 'STAV', value: 'Připravena', textAlignment: 'PKTextAlignmentRight' }
          : {
            key: 'left',
            label: 'ZBÝVÁ',
            value: misek(left),
            textAlignment: 'PKTextAlignmentRight',
          },
      ],
      backFields: [
        ...(card.news ? [{ key: 'news', label: 'Novinka', value: card.news, changeMessage: '%@' }] : []),
        { key: 'how', label: 'Jak to funguje', value: `Za každé jídlo dostanete na kase jednu misku. Za ${goal} misek máte ${cfg.rewardText.toLowerCase()} (${cfg.rewardDetail}). Pak karta začne znovu.` },
        { key: 'hours', label: 'Otevřeno', value: v.hours },
        { key: 'address', label: 'Kde nás najdete', value: v.address },
        { key: 'phone', label: 'Telefon', value: v.phone },
        { key: 'order', label: 'Objednat online', value: v.orderUrl },
        { key: 'terms', label: 'Podmínky programu', value: `${cfg.siteUrl}/vernost/#podminky` },
        { key: 'code', label: 'Číslo karty', value: card.code },
      ],
    },
  };
}

export function stripFiles(card, cfg) {
  const goal = cfg.stampsGoal;
  const s = Math.min(Number(card.stamps), goal);
  return {
    'strip@2x.png': asset('strips', String(goal), `strip-${s}@2x.png`),
    'strip@3x.png': asset('strips', String(goal), `strip-${s}@3x.png`),
  };
}

export function buildPkpass(card, cfg) {
  const a = cfg.apple;
  const files = {
    'pass.json': Buffer.from(JSON.stringify(buildPassJson(card, cfg))),
    'icon.png': asset('pass', 'icon.png'),
    'icon@2x.png': asset('pass', 'icon@2x.png'),
    'icon@3x.png': asset('pass', 'icon@3x.png'),
    'logo.png': asset('pass', 'logo.png'),
    'logo@2x.png': asset('pass', 'logo@2x.png'),
    'logo@3x.png': asset('pass', 'logo@3x.png'),
    ...stripFiles(card, cfg),
  };
  const pass = new PKPass(files, {
    wwdr: a.wwdr,
    signerCert: a.signerCert,
    signerKey: a.signerKey,
    signerKeyPassphrase: a.signerKeyPassphrase,
  });
  return pass.getAsBuffer();
}
