// Po změně karet pošle signál do iPhonů (APNs) a aktualizuje karty v Google Peněžence.
// Běží na pozadí, aby personál na kase nečekal na Apple ani Google.

function placeholders(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => `$${i + 1 + offset}`).join(', ');
}

export function createNotifier({ db, apns, google, log = console }) {
  let queue = Promise.resolve();

  async function run(serials, reason) {
    for (let i = 0; i < serials.length; i += 500) {
      const chunk = serials.slice(i, i + 500);

      if (apns) {
        const { rows } = await db.query(
          `SELECT r.push_token FROM registrations r WHERE r.serial IN (${placeholders(chunk.length)})`,
          chunk,
        );
        if (rows.length) {
          const results = await apns.push(rows.map((r) => r.push_token));
          const gone = results.filter((r) => r.status === 410).map((r) => r.token);
          if (gone.length) {
            await db.query(`DELETE FROM registrations WHERE push_token IN (${placeholders(gone.length)})`, gone);
          }
        }
      }

      if (google) {
        const { rows } = await db.query(
          `SELECT * FROM cards WHERE platform = 'google' AND serial IN (${placeholders(chunk.length)})`,
          chunk,
        );
        for (const card of rows) await google.updateCard(card, reason);
      }
    }
  }

  function notify(serials, reason) {
    if (!serials.length || (!apns && !google)) return Promise.resolve();
    queue = queue.then(() => run(serials, reason)).catch((e) => log.error('Oznámení selhalo:', e.message));
    return Promise.resolve(); // nečekáme
  }

  notify.idle = () => queue;
  return notify;
}
