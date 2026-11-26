// Builds the public, save-free wiki into dist/wiki/ (index.html + wiki.json).
// Run: node build-wiki.js [outDir]   (or double-click Build-Public-Wiki.cmd)
// The output is static files: host it anywhere (GitHub Pages, Netlify, any web server).
// Only game data goes in. No save, no personal panels, no decompiled code. Visitors can load their own save,
// which is read in their browser (lib/savecore.js, lib/brotli.js) and never sent anywhere.
const fs = require('fs');
const path = require('path');
const { findGameExe, readPackFile } = require('./lib/gamedata');
const { buildDb } = require('./lib/gamedb');
const { enrichDb } = require('./lib/wikiextra');
{ // unpack data/img.tar if it's newer than data/img
  const tarFile = path.join(__dirname, 'data', 'img.tar'), idx = path.join(__dirname, 'data', 'img', 'index.json');
  if (fs.existsSync(tarFile) && (!fs.existsSync(idx) || fs.statSync(tarFile).mtimeMs > fs.statSync(idx).mtimeMs)) {
    require('child_process').execFileSync('tar', ['-xf', tarFile, '-C', path.join(__dirname, 'data')]);
    fs.utimesSync(idx, new Date(), new Date());
  }
}

const DATA_FILE = path.join(__dirname, 'data', 'MelvorBase.json');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'dist', 'wiki'));

const exe = findGameExe();
if (exe && (!fs.existsSync(DATA_FILE) || fs.statSync(exe).mtimeMs > fs.statSync(DATA_FILE).mtimeMs)) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, readPackFile(exe, 'Data/Packages/MelvorBase.json').bytes);
  console.log('Game data refreshed from', exe);
}
if (!fs.existsSync(DATA_FILE)) { console.error('No game data. Run Extract-Game-Data.cmd once.'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const db = enrichDb(buildDb(data), data, { public: true });
let html = fs.readFileSync(path.join(__dirname, 'public', 'wiki.html'), 'utf8');
html = html
  .replace('<script>', '<script>window.MI2_STATIC = true;</script>\n<script>')
  .replace(/\s*<a class="back" href="\/">[^<]*<\/a>/, '');   // the link back to the local tools
if (!html.includes('MI2_STATIC = true') || html.includes('class="back"')) { console.error('wiki.html layout changed; update build-wiki.js'); process.exit(1); }

fs.mkdirSync(out, { recursive: true });
// changes.json: what changed since the last published build (read before wiki.json is replaced).
{
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const prev = read(path.join(out, 'wiki.json'));
  const history = require('./lib/changes').updateHistory(prev, db, read(path.join(out, 'changes.json')) || []);
  fs.writeFileSync(path.join(out, 'changes.json'), JSON.stringify(history));
  // The local tools' wiki reads the same history from data/.
  fs.writeFileSync(path.join(__dirname, 'data', 'changes.json'), JSON.stringify(history));
  console.log(`  changes.json ${history.length ? `${history.length} update(s), latest ${history[0].from} -> ${history[0].to}: +${history[0].add.length} -${history[0].rem.length} ~${history[0].chg.length}` : 'no changes recorded yet'}`);
}
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'wiki.json'), JSON.stringify(db));
// combat.js: the combat formulas, shared with the local tools, for the wiki's calculator.
fs.copyFileSync(path.join(__dirname, 'lib', 'combat.js'), path.join(out, 'combat.js'));
// Load my save: the save parser (shared with the local tools) and a Brotli decoder, run in the browser.
for (const f of ['savecore.js', 'brotli.js', 'brotli-dict.bin', 'brotli-LICENSE.txt']) fs.copyFileSync(path.join(__dirname, 'lib', f), path.join(out, f));
// spyglass.json: item sources, uses and unlocks for the in-game Spyglass lookup.
fs.writeFileSync(path.join(out, 'spyglass.json'), JSON.stringify(require('./lib/spyglass').buildSpyglass(db)));
// cleanup.json: what each item is for, so the in-game Hold mod can say what in your bank is safe to sell.
fs.writeFileSync(path.join(out, 'cleanup.json'), JSON.stringify(require('./lib/cleanup').cleanupFacts(db)));
// plan.json: the small slice the in-game Course planner downloads (item names and per-hour action rates).
{
  const items = {};
  for (const r of Object.values(db.records)) if (r.t === 'Item') items[r.id] = r.n;
  const rates = Object.entries(db.rates || {}).filter(([, x]) => x.area !== 'Quests')
    .map(([id, x]) => ({ id, skill: x.skill, name: x.name, level: x.level, sec: x.sec, xp: x.xp, out: x.out, in: x.in }));
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify({ gameVersion: db.gameVersion, items, rates }));
}
// Copy the game images the wiki uses.
const imgSrc = path.join(__dirname, 'data', 'img');
let copied = 0;
if (fs.existsSync(imgSrc)) for (const rel of new Set(Object.values(db.images || {}))) {
  const from = path.join(imgSrc, rel), to = path.join(out, 'img', rel);
  if (!fs.existsSync(from)) continue;
  if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) { copied++; continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); copied++;
}
console.log(`  img/       ${copied} images`);
const kb = f => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + ' KB';
console.log(`Wrote ${out}\n  index.html ${kb('index.html')}\n  plan.json  ${kb('plan.json')}\n  wiki.json  ${kb('wiki.json')} (${Object.keys(db.records).length} records, ${db.namespace})`);
