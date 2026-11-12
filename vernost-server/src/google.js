// Google Peněženka (Google Wallet API, typ Loyalty). Zapne se vyplněním GOOGLE_ISSUER_ID
// a GOOGLE_SERVICE_ACCOUNT_JSON. Bez nich server běží jen s Apple Wallet.
import crypto from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { headerMessage } from './pass.js';

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signJwt(payload, privateKey) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export function createGoogleWallet(cfg, { log = console, fetchImpl = fetch } = {}) {
  const g = cfg.google;
  const goal = cfg.stampsGoal;
  const classId = `${g.issuerId}.${g.classSuffix}`;
  const objectId = (card) => `${g.issuerId}.${card.serial}`;
  const auth = new GoogleAuth({
    credentials: g.serviceAccount,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });

  async function call(method, url, body) {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const res = await fetchImpl(`${API}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Google Wallet ${method} ${url}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  function classDef() {
    return {
      id: classId,
      issuerName: cfg.venue.name,
      programName: 'Věrnostní karta',
      programLogo: { sourceUri: { uri: `${cfg.publicUrl}/assets/google/logo.png` } },
      hexBackgroundColor: '#161616',
      countryCode: 'CZ',
      reviewStatus: 'UNDER_REVIEW',
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
    };
  }

  function objectFor(card) {
    const stamps = Number(card.stamps);
    const shown = Math.min(stamps, goal);
    return {
      id: objectId(card),
      classId,
      state: 'ACTIVE',
      accountId: card.code,
      accountName: card.code,
      loyaltyPoints: { label: 'Misky', balance: { string: `${shown} / ${goal}` } },
      barcode: { type: 'QR_CODE', value: card.code, alternateText: card.code },
      heroImage: { sourceUri: { uri: `${cfg.publicUrl}/assets/strips/${goal}/strip-${shown}@3x.png` } },
      textModulesData: [
        { id: 'reward', header: 'Odměna', body: `Za ${goal} misek ${cfg.rewardText.toLowerCase()} (${cfg.rewardDetail}).` },
        ...(card.news ? [{ id: 'news', header: 'Novinka', body: card.news }] : []),
        { id: 'hours', header: 'Otevřeno', body: cfg.venue.hours },
        { id: 'address', header: 'Kde nás najdete', body: cfg.venue.address },
      ],
      linksModuleData: { uris: [{ id: 'order', uri: cfg.venue.orderUrl, description: 'Objednat online' }] },
    };
  }

  async function ensureClass() {
    const existing = await call('GET', `/loyaltyClass/${classId}`);
    if (existing) return call('PATCH', `/loyaltyClass/${classId}`, classDef());
    return call('POST', '/loyaltyClass', classDef());
  }

  // Odkaz „Uložit do Google Peněženky“. Objekt se v Googlu založí až uložením.
  function saveUrl(card) {
    const jwt = signJwt({
      iss: g.serviceAccount.client_email,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: [cfg.siteUrl],
      payload: { loyaltyObjects: [objectFor(card)] },
    }, g.serviceAccount.private_key);
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }

  async function updateCard(card, reason) {
    try {
      const updated = await call('PATCH', `/loyaltyObject/${objectId(card)}`, objectFor(card));
      if (!updated) return; // host kartu ještě neuložil
      let text = null;
      if (reason === 'broadcast') text = card.news;
      else if (reason === 'stamp' || reason === 'redeem') {
        text = headerMessage(Number(card.stamps), goal, Number(card.rewards_redeemed))
          .replace('%@', `${Math.min(Number(card.stamps), goal)} / ${goal}`);
      }
      if (text) {
        await call('POST', `/loyaltyObject/${objectId(card)}/addMessage`, {
          message: { id: `m${Date.now()}`, header: cfg.venue.name, body: text, messageType: 'TEXT_AND_NOTIFY' },
        });
      }
    } catch (e) {
      log.error('Google Wallet aktualizace selhala:', e.message);
    }
  }

  return { ensureClass, saveUrl, updateCard, objectFor, classDef };
}
