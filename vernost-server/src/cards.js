// Logika věrnostního programu: vydání karty, přičtení misek, uplatnění odměny, vrácení kroku.
import crypto from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // bez 0/O a 1/I, aby šel kód přepsat rukou

export function newCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `EB-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const body = raw.startsWith('EB') ? raw.slice(2) : raw;
  if (body.length !== 8) return null;
  return `EB-${body.slice(0, 4)}-${body.slice(4)}`;
}

export class CardError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function cardView(card, goal) {
  if (!card) return null;
  const stamps = Number(card.stamps);
  return {
    code: card.code,
    serial: card.serial,
    platform: card.platform,
    stamps,
    goal,
    shown: Math.min(stamps, goal),
    full: stamps >= goal,
    left: Math.max(goal - stamps, 0),
    stampsTotal: Number(card.stamps_total),
    rewardsRedeemed: Number(card.rewards_redeemed),
    lastVisitAt: card.last_visit_at,
    createdAt: card.created_at,
  };
}

export function createCards({ db, cfg, notify = async () => {} }) {
  const goal = cfg.stampsGoal;
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;

  async function getByCode(code) {
    const c = normalizeCode(code);
    return c ? one('SELECT * FROM cards WHERE code = $1', [c]) : null;
  }

  async function getBySerial(serial) {
    return one('SELECT * FROM cards WHERE serial = $1', [serial]);
  }

  async function requireCard(code) {
    const card = await getByCode(code);
    if (!card) throw new CardError('NOT_FOUND', 'Karta s tímto kódem neexistuje.', 404);
    return card;
  }

  async function logEvent(serial, type, amount, staffId) {
    return one(
      'INSERT INTO events (serial, type, amount, staff_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [serial, type, amount, staffId ?? null],
    );
  }

  async function issueCard({ platform, email } = {}) {
    if (!['apple', 'google'].includes(platform)) throw new CardError('BAD_PLATFORM', 'Neznámá platforma.');
    const welcome = Number((await one("SELECT value FROM settings WHERE key = 'welcome_stamps'"))?.value || 0);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const card = await one(
          `INSERT INTO cards (serial, code, auth_token, platform, stamps, stamps_total, email, updated_ms)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7) RETURNING *`,
          [crypto.randomUUID(), newCode(), crypto.randomBytes(24).toString('hex'), platform, welcome, email || null, Date.now()],
        );
        await logEvent(card.serial, 'issue', welcome, null);
        return card;
      } catch (e) {
        if (!/duplicate|unique/i.test(e.message)) throw e; // kolize kódu je téměř nemožná, ale zkusíme znovu
      }
    }
    throw new Error('Nepodařilo se vygenerovat unikátní kód karty.');
  }

  async function lastStamp(serial) {
    return one(
      "SELECT * FROM events WHERE serial = $1 AND type = 'stamp' AND undone = false ORDER BY id DESC LIMIT 1",
      [serial],
    );
  }

  async function stamp({ code, amount = 1, staffId, confirm = false }) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 1 || n > cfg.maxStampsPerScan) {
      throw new CardError('BAD_AMOUNT', `Najednou jde přičíst 1 až ${cfg.maxStampsPerScan} misky.`);
    }
    const card = await requireCard(code);
    const last = await lastStamp(card.serial);
    if (last && !confirm) {
      const ageMin = (Date.now() - new Date(last.created_at).getTime()) / 60000;
      if (ageMin < cfg.rescanWindowMinutes) {
        throw new CardError(
          'RECENT_STAMP',
          `Tato karta dostala misku před ${Math.max(1, Math.round(ageMin))} min. Opravdu přičíst znovu?`,
          409,
        );
      }
    }
    const updated = await one(
      `UPDATE cards SET stamps = stamps + $1, stamps_total = stamps_total + $1,
         last_visit_at = now(), updated_ms = $2 WHERE serial = $3 RETURNING *`,
      [n, Date.now(), card.serial],
    );
    const event = await logEvent(card.serial, 'stamp', n, staffId);
    await notify([card.serial], 'stamp');
    return { card: updated, event };
  }

  async function redeem({ code, staffId }) {
    const card = await requireCard(code);
    const updated = await one(
      `UPDATE cards SET stamps = stamps - $1::integer, rewards_redeemed = rewards_redeemed + 1,
         last_visit_at = now(), updated_ms = $2 WHERE serial = $3 AND stamps >= $1 RETURNING *`,
      [goal, Date.now(), card.serial],
    );
    if (!updated) {
      throw new CardError('NOT_FULL', `Karta ještě není plná (${card.stamps} z ${goal} misek).`, 409);
    }
    const event = await logEvent(card.serial, 'redeem', goal, staffId);
    await notify([card.serial], 'redeem');
    return { card: updated, event };
  }

  async function undo({ eventId, staffId }) {
    const ev = await one('SELECT * FROM events WHERE id = $1', [eventId]);
    if (!ev || ev.undone || !['stamp', 'redeem'].includes(ev.type)) {
      throw new CardError('CANNOT_UNDO', 'Tento krok nejde vrátit.', 409);
    }
    if (staffId != null && ev.staff_id !== staffId) {
      throw new CardError('CANNOT_UNDO', 'Vrátit jde jen vlastní krok.', 403);
    }
    const ageMin = (Date.now() - new Date(ev.created_at).getTime()) / 60000;
    if (ageMin > cfg.undoWindowMinutes) {
      throw new CardError('CANNOT_UNDO', `Vrátit jde jen do ${cfg.undoWindowMinutes} minut.`, 409);
    }
    let updated;
    if (ev.type === 'stamp') {
      updated = await one(
        `UPDATE cards SET stamps = GREATEST(stamps - $1::integer, 0), stamps_total = GREATEST(stamps_total - $1::integer, 0),
           updated_ms = $2 WHERE serial = $3 RETURNING *`,
        [ev.amount, Date.now(), ev.serial],
      );
    } else {
      updated = await one(
        `UPDATE cards SET stamps = stamps + $1, rewards_redeemed = GREATEST(rewards_redeemed - 1, 0),
           updated_ms = $2 WHERE serial = $3 RETURNING *`,
        [ev.amount, Date.now(), ev.serial],
      );
    }
    await db.query('UPDATE events SET undone = true WHERE id = $1', [ev.id]);
    await notify([ev.serial], 'undo');
    return { card: updated };
  }

  async function recentEvents(limit = 20) {
    const { rows } = await db.query(
      `SELECT e.id, e.type, e.amount, e.undone, e.created_at, e.staff_id, c.code, s.name AS staff_name
       FROM events e JOIN cards c ON c.serial = e.serial LEFT JOIN staff s ON s.id = e.staff_id
       WHERE e.type <> 'issue' ORDER BY e.id DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async function stats() {
    const q = async (sql) => Number((await one(sql))?.n || 0);
    return {
      cards: await q('SELECT COUNT(*) AS n FROM cards'),
      cardsApple: await q("SELECT COUNT(*) AS n FROM cards WHERE platform = 'apple'"),
      cardsGoogle: await q("SELECT COUNT(*) AS n FROM cards WHERE platform = 'google'"),
      activeDevices: await q('SELECT COUNT(DISTINCT serial) AS n FROM registrations'),
      stamps30d: await q("SELECT COALESCE(SUM(amount), 0) AS n FROM events WHERE type = 'stamp' AND undone = false AND created_at > now() - interval '30 days'"),
      rewards30d: await q("SELECT COUNT(*) AS n FROM events WHERE type = 'redeem' AND undone = false AND created_at > now() - interval '30 days'"),
      fullCards: await q(`SELECT COUNT(*) AS n FROM cards WHERE stamps >= ${goal}`),
    };
  }

  // Hromadná zpráva: nový text pole „Novinka“ u všech karet. Vrací počet karet.
  async function broadcast(text) {
    const clean = String(text || '').trim();
    if (clean.length < 3 || clean.length > 200) {
      throw new CardError('BAD_TEXT', 'Zpráva musí mít 3 až 200 znaků.');
    }
    const { rows } = await db.query('UPDATE cards SET news = $1, updated_ms = $2 RETURNING serial', [clean, Date.now()]);
    await db.query('INSERT INTO broadcasts (text, sent_count) VALUES ($1, $2)', [clean, rows.length]);
    await notify(rows.map((r) => r.serial), 'broadcast');
    return rows.length;
  }

  return { getByCode, getBySerial, issueCard, stamp, redeem, undo, recentEvents, stats, broadcast, view: (c) => cardView(c, goal) };
}
