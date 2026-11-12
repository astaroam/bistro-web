# Věrnostní karta eBISTRO

Server pro věrnostní kartu v Apple Wallet a Google Peněžence. Za každé jídlo jedna miska, za 8 misek jídlo zdarma.

Co v něm je:

| Adresa | K čemu |
| --- | --- |
| `/karta/apple` | Vydá novou kartu do Apple Wallet (odkaz ze stránky e-bistro.cz/vernost) |
| `/karta/google` | Vydá novou kartu do Google Peněženky |
| `/kasa/` | Aplikace pro personál: přihlášení PINem, sken QR, +1 až +3 misky, uplatnění odměny, vrácení kroku |
| `/admin/` | Správa: přehled, hromadná zpráva všem hostům, PINy personálu, uvítací misky |
| `/wallet/v1/…` | Webová služba, kterou volá iPhone (registrace, aktualizace karty) |

Stránka pro hosty je v repozitáři webu ve složce `../vernost/` a publikuje se s webem na e-bistro.cz/vernost.

## Vyzkoušení bez databáze a certifikátů

```bash
npm install
node scripts/dev-memory.js
```

Pak otevřete http://localhost:3000/kasa/ (PIN 1234) a http://localhost:3000/admin/ (heslo `admin`). Server vytvoří tři ukázkové karty a vypíše jejich kódy, které jde v Kase zadat ručně. Karta do Apple Wallet se bez certifikátu vydat nedá, stránka slušně odpoví, že karta zatím není.

Testy: `npm test`.

## Nasazení

Potřebujete hosting pro Node.js 20+ s databází Postgres, například Render, Railway nebo Fly.io. Server je v jednom kontejneru (`Dockerfile`), databázové tabulky si založí sám při startu.

1. Založte službu z této složky (`vernost-server`) a k ní databázi Postgres.
2. Vyplňte proměnné prostředí podle `.env.example`. Minimum: `DATABASE_URL`, `PUBLIC_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD`.
3. V DNS domény e-bistro.cz přidejte `karta` jako CNAME na adresu od hostingu a zapněte HTTPS.
4. Přidejte první členy personálu v `/admin/` (nebo `node scripts/add-staff.js "Petra" 1234`).
5. Ověřte `https://karta.e-bistro.cz/health`, má vrátit `"ok": true`.

Server musí běžet jako jedna instance (limit pokusů o přihlášení je v paměti).

## Apple Wallet

1. Na developer.apple.com → Certificates, Identifiers & Profiles → Identifiers → „+“ → Pass Type IDs vytvořte `pass.cz.ebistro.vernost`.
2. `./scripts/make-csr.sh vas@email.cz` vytvoří `certs/pass.key` a `certs/pass.csr`. Klíč nikam nenahrávejte.
3. Certificates → „+“ → Pass Type ID Certificate → vyberte identifikátor, nahrajte `certs/pass.csr`, stáhněte `pass.cer`.
4. Převeďte certifikáty (příkazy vypíše skript z bodu 2) na `certs/pass.pem` a `certs/wwdr.pem`.
5. Na hostingu vyplňte `APPLE_TEAM_ID` (Membership details) a certifikáty, buď jako soubory (`APPLE_PASS_CERT_FILE`…), nebo jako text (`APPLE_PASS_CERT`…, zalomení řádků jako `\n`).

Tentýž certifikát slouží k podpisu karet i k oznámením přes APNs. Platí rok, obnovuje se stejným postupem a karty v telefonech zůstávají.

## Google Peněženka (nepovinné)

1. Založte vydavatele v Google Pay & Wallet Console a opište Issuer ID.
2. V Google Cloud zapněte Google Wallet API, vytvořte servisní účet, stáhněte jeho JSON klíč a v konzoli ho přidejte jako uživatele.
3. Vyplňte `GOOGLE_ISSUER_ID` a `GOOGLE_SERVICE_ACCOUNT_JSON` (nebo `_FILE`).
4. Jednou spusťte `node scripts/google-setup.js`, založí třídu karty.
5. V konzoli požádejte o produkční přístup. Do schválení karta funguje jen pro testovací účty.

## Jak funguje oznámení

Po skenu na kase server zvýší počet misek a pošle iPhonům s touto kartou prázdný signál přes APNs. iPhone si stáhne novou kartu a u pole, které se změnilo, ukáže text z `changeMessage`:

- běžně „Díky za návštěvu! Stav karty: 4 / 8“
- při 7 z 8 „Poslední miska chybí. Příště je jídlo na nás.“
- plná karta „Máte jídlo zdarma! Ukažte kartu na kase.“
- po uplatnění „Dobrou chuť! Karta začíná znovu od nuly.“

Hromadná zpráva z administrace změní pole „Novinka“ na zadní straně všech karet. Google Peněženka dostává stejné texty jako zprávy na kartě.

## Obrázky karty

Ikona, logo a pruhy s miskami (pro 5 až 10 misek) jsou hotové v `assets/`. Při změně designu je přegenerujte příkazem `npm run assets` (potřebuje Playwright s Chromiem).

## Počet misek a odměna

Nastavují se proměnnými `STAMPS_GOAL` (5 až 10), `REWARD_TEXT` a `REWARD_DETAIL`. Při změně počtu misek upravte i `GOAL` ve stránce `../vernost/index.html`.
