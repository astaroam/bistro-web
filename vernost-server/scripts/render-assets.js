// Vykreslí obrázky karty (ikona, logo, pruhy s miskami) do assets/.
// Spouští se jen při změně designu: `npm run assets`. Výsledné PNG jsou v gitu.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (...p) => path.join(root, 'assets', ...p);

const YELLOW = '#F7CE1B';
const NIGHT = '#161616';
const STRIP_BG = '#1F1F1E';
const PAT = 'FOOD IS LOVE · '.repeat(12);

function bowl(on) {
  const c = on ? YELLOW : 'rgba(255,255,255,.32)';
  const dash = on ? '' : ' stroke-dasharray="3 3"';
  const steam = on ? `<path d="M19 12c-2-3 2-4 0-7M24 12c-2-3 2-4 0-7M29 12c-2-3 2-4 0-7" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round"/>` : '';
  const sticks = on ? '<path d="M30 20 L43 6 M33 20 L45 9" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' : '';
  return `<svg viewBox="0 0 48 48">${steam}${sticks}<path d="M5 21h38a19 17 0 0 1-38 0z" fill="${on ? YELLOW : 'none'}" stroke="${c}" stroke-width="2.2"${dash}/>${on ? `<path d="M5 21h38" stroke="${NIGHT}" stroke-width="2"/>` : ''}<path d="M17 39h14" stroke="${c}" stroke-width="2.6" stroke-linecap="round"${dash}/></svg>`;
}

const fullBowl = `<svg viewBox="0 0 48 48" class="fb"><path d="M19 12c-2-3 2-4 0-7M24 12c-2-3 2-4 0-7M29 12c-2-3 2-4 0-7" stroke="#141414" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M5 21h38a19 17 0 0 1-38 0z" fill="#141414"/><path d="M17 39h14" stroke="#141414" stroke-width="2.6" stroke-linecap="round"/></svg>`;

function stripHTML(goal, stamps) {
  const full = stamps >= goal;
  const cols = goal <= 5 ? goal : Math.ceil(goal / 2);
  const rows = Array.from({ length: 14 }, () => `<span>${PAT}</span>`).join('');
  const body = full
    ? `<div class="free">${fullBowl}<b>Jídlo zdarma</b><span>Ukažte kartu na kase</span></div>`
    : `<div class="bowls" style="grid-template-columns:repeat(${cols},1fr);width:${cols * 50}px">${Array.from({ length: goal }, (_, i) => bowl(i < stamps)).join('')}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@500&family=Titillium+Web:wght@600&display=swap">
<style>
html,body{margin:0}
.strip{width:375px;height:144px;position:relative;overflow:hidden;display:grid;place-items:center;background:${full ? YELLOW : STRIP_BG};color:#141414}
.pat{position:absolute;left:50%;top:50%;width:260%;height:300%;transform:translate(-50%,-50%) rotate(-22deg);display:grid;align-content:center;gap:.3em;font:500 24px/1 Oswald,sans-serif;white-space:nowrap;color:${full ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.03)'}}
.pat span:nth-child(odd){margin-left:-1.4em}
.bowls{position:relative;display:grid;gap:4px 8px;max-width:340px}
.bowls svg{width:100%;aspect-ratio:1;display:block}
.free{position:relative;display:grid;justify-items:center;gap:2px;text-align:center}
.free .fb{width:40px;height:40px}
.free b{font:500 32px/1 Oswald,sans-serif;text-transform:uppercase;letter-spacing:.02em}
.free span{font:600 13px/1.2 "Titillium Web",sans-serif}
</style></head><body><div class="strip"><div class="pat">${rows}</div>${body}</div></body></html>`;
}

const iconHTML = `<!doctype html><html><head><style>html,body{margin:0}.i{width:29px;height:29px;background:${NIGHT};display:grid;place-items:center}.i svg{width:23px;height:23px}</style></head><body><div class="i">${bowl(true)}</div></body></html>`;

async function shot(page, html, selector, file, scale) {
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const el = await page.$(selector);
  await mkdir(path.dirname(file), { recursive: true });
  const png = await el.screenshot({ omitBackground: false });
  // Paletové PNG je 4× menší a na kartě nepoznáte rozdíl.
  await writeFile(file, await sharp(png).png({ palette: true, quality: 90, effort: 10 }).toBuffer());
}

const browser = await chromium.launch();
for (const scale of [1, 2, 3]) {
  const page = await browser.newPage({ deviceScaleFactor: scale });
  const sfx = scale === 1 ? '' : `@${scale}x`;
  await shot(page, iconHTML, '.i', out('pass', `icon${sfx}.png`), scale);
  if (scale > 1) {
    for (let goal = 5; goal <= 10; goal++) {
      for (let s = 0; s <= goal; s++) {
        await shot(page, stripHTML(goal, s), '.strip', out('strips', String(goal), `strip-${s}${sfx}.png`), scale);
      }
    }
  }
  await page.close();
}
await browser.close();

// Logo: webové logo.png má 384 × 150 px, to je přesně @3x pro maximální velikost 160 × 50 bodů.
const logo = await readFile(path.join(root, '..', 'logo.png'));
await writeFile(out('pass', 'logo@3x.png'), logo);
const b2 = await chromium.launch();
const p2 = await b2.newPage();
const data = `data:image/png;base64,${logo.toString('base64')}`;
for (const [w, h, name] of [[128, 50, 'logo.png'], [256, 100, 'logo@2x.png']]) {
  await p2.setViewportSize({ width: w, height: h });
  await p2.setContent(`<html><body style="margin:0;background:transparent"><img src="${data}" style="width:${w}px;height:${h}px;display:block"></body></html>`);
  await p2.screenshot({ path: out('pass', name), omitBackground: true });
}
await b2.close();
// Logo programu pro Google Peněženku: čtverec 660 × 660, žlutá miska na černé (Google ho ořízne do kruhu).
await mkdir(out('google'), { recursive: true });
const gsvg = `<svg xmlns="http://www.w3.org/2000/svg" width="660" height="660" viewBox="0 0 660 660"><rect width="660" height="660" fill="${NIGHT}"/><g transform="translate(150 150) scale(7.5)">${bowl(true).replace('<svg viewBox="0 0 48 48">', '').replace('</svg>', '')}</g></svg>`;
await writeFile(out('google', 'logo.png'), await sharp(Buffer.from(gsvg)).png({ palette: true }).toBuffer());
console.log('Hotovo: assets/pass, assets/strips, assets/google');
