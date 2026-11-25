// Extra wiki data shared by the local server and the public build: modifier text templates,
// the XP table, and reference rates for every skilling action (no account bonuses, no gear, max level).
const { buildCatalog, evaluate } = require('./money');
const { XP_TABLE } = require('./save');
const { buildAstroData } = require('./astrology');
const fs = require('fs');
const path = require('path');

// Mechanics notes. The public build drops code references and anything about one player's save.
function publicGuide(md) {
  return md
    .replace(/^Formulas read from.*$/m, 'Formulas worked out from the game and checked against it in play. "floor" = round down. Percent values are fractions (0.05 = 5%).')
    // "Source: `A`, `B`. Rest of line" keeps only the rest.
    .split('\n').map(l => /^Sources?: /.test(l) ? l.replace(/^Sources?: .*?\.(\s|$)/, '').trim() : l).filter((l, i, a) => l || !/^Sources?: /.test(md.split('\n')[i] || '')).join('\n')
    .replace(/\s*\(`[A-Z][\w./]*`(?:, `[\w./]+`)*\)/g, '')
    .replace(/ Used by the Astrolabe Tools combat calculator \(`lib\/combat\.js`\)\./g, '')
    .replace(/\s*\([^()]*elo's save\)/g, '')
    .replace(/\n## Validation against the game[\s\S]*?(?=\n## )/, '\n');
}

function enrichDb(db, data, { public: pub = false } = {}) {
  const docs = path.join(__dirname, '..', 'docs', 'mechanics.md');
  if (fs.existsSync(docs)) {
    const md = fs.readFileSync(docs, 'utf8');
    db.gameVersion = (md.match(/\((v[\d.]+[^)]*)\)/) || [])[1] || null;
    db.guides = { mechanics: pub ? publicGuide(md) : md };
  }
  // data/version.txt (written by extract-data.js) is the installed game's own version.
  const ver = path.join(__dirname, '..', 'data', 'version.txt');
  if (fs.existsSync(ver)) db.gameVersion = fs.readFileSync(ver, 'utf8').trim() || db.gameVersion;
  db.built = new Date().toISOString().slice(0, 10);
  // Game images: res:// path -> file under data/img (see unpack-assets.js).
  const imgIndex = path.join(__dirname, '..', 'data', 'img', 'index.json');
  db.images = fs.existsSync(imgIndex) ? JSON.parse(fs.readFileSync(imgIndex, 'utf8')) : {};
  db.mods = { global: data.GlobalModifierDescriptions || [], component: data.ComponentModifierDescriptions || [] };
  db.xpTable = XP_TABLE;
  const cat = buildCatalog(data);
  const levels = Object.fromEntries(Object.keys(data.EntityConfig).map(k => [k.split(':').pop(), 120]));
  const bank = Object.fromEntries(Object.keys(cat.items).map(k => [k, 1e9]));
  const rate = (useGear) => evaluate(cat, { levels, bank, toolbelts: {}, useGear, hours: 8, countInputs: true });
  db.rates = {};
  for (const r of rate(false)) {
    db.rates[r.id] = {
      gp: Math.round(r.gpPerHour), sales: Math.round(r.sales ?? 0), xp: Math.round(r.xpPerHour), sec: +r.seconds.toFixed(3), success: +r.success.toFixed(4), unit: r.unit || null,
      skill: r.skill, name: r.name, area: r.area, level: (cat.actions.find(a => a.id === r.id)?.requirements || []).find(q => q.type === 'Level' && q.skill === r.skill)?.level ?? 1,
      needs: r.notes.filter(n => n.startsWith('equip ')).map(n => n.slice(6)),
      out: r.outputs.map(o => [o.id, +o.perHour.toFixed(2)]), in: r.inputs.map(i => [i.id, +i.perHour.toFixed(2)]),
    };
  }
  // Astrology: constellations, gates, observation odds, and studying as a training action.
  const ad = db.astro = buildAstroData(data);
  for (const c of ad.cons) db.rates['Astrology:' + c.id] = {
    gp: 0, sales: 0, xp: Math.round(3600000 / c.interval * c.xp), sec: c.interval / 1000, success: 1, unit: 'study', skill: 'Astrology', name: c.name, area: 'Constellation', level: c.level,
    needs: c.secondary.length ? [c.secondary.map(q => q.skill + ' ' + q.level).join(' or ')] : [], out: [], in: [],
  };
  // Mark actions that need an astrology major node or observation first.
  const gateOf = {};
  for (const [node, list] of Object.entries(ad.gates)) for (const k of list) gateOf[k] = { node };
  for (const [ev, list] of Object.entries(ad.obsGates)) for (const k of list) gateOf[k] ||= { obs: ev };
  for (const [id, r] of Object.entries(db.rates)) {
    const [skill, rid] = [r.skill, id.split(':').slice(1).join(':')];
    const key = Object.keys(db.records).find(k => db.records[k].id === rid && db.records[k].o === skill);
    const rec = key && db.records[key];
    const cat = rec?.d?.Category && ('RecipeCategory:' + String(rec.d.Category).split(':').pop());
    const g = (key && gateOf[key]) || (cat && gateOf[cat]);
    if (g) r.gate = g;
  }
  return db;
}

module.exports = { enrichDb };
