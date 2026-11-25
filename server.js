// Astrolabe Tools: local web app that reads your Melvor Idle 2 save.
// Run: node server.js   (or double-click Start-MI2-Tools.cmd)
// Optional: node server.js "C:\path\to\save.sav"   to read a specific save.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { readSave, findSave, XP_TABLE } = require('./lib/save');
const { findGameExe, readPackFile } = require('./lib/gamedata');
const { buildCatalog, evaluate, evaluatePassive } = require('./lib/money');
const { buildDb } = require('./lib/gamedb');
const { enrichDb } = require('./lib/wikiextra');
const { buildCombatData, evaluateCombat } = require('./lib/combat');
const { buildBonusData, accountBonuses } = require('./lib/bonuses');
const { upgrades } = require('./lib/upgrades');
const { workbook } = require('./lib/xlsx');
const { buildGearData, bestGear, openSlots, currentSlots } = require('./lib/gear');
const { buildAstroData, astroPlan } = require('./lib/astrology');
const zlib = require('zlib');

const PORT = Number(process.env.MI2_PORT) || 5320;
const PUBLIC = path.join(__dirname, 'public');
// Game images ship as data\img.tar; unpack once (Windows 10+ has tar built in).
{
  const tarFile = path.join(__dirname, 'data', 'img.tar'), imgDir = path.join(__dirname, 'data', 'img');
  if (fs.existsSync(tarFile) && (!fs.existsSync(path.join(imgDir, 'index.json')) || fs.statSync(tarFile).mtimeMs > fs.statSync(path.join(imgDir, 'index.json')).mtimeMs)) {
    try { require('child_process').execFileSync('tar', ['-xf', tarFile, '-C', path.join(__dirname, 'data')]); fs.utimesSync(path.join(imgDir, 'index.json'), new Date(), new Date()); console.log('Unpacked game images'); }
    catch (e) { console.log('Could not unpack data\\img.tar:', e.message); }
  }
}
const fixedSave = process.argv[2];

let cache = { file: null, mtime: 0, data: null };
function getSave() {
  const file = fixedSave || findSave();
  if (!file) throw new Error('No Melvor Idle 2 save found under %APPDATA%\\Games By Malcs. Pass a .sav path as an argument.');
  const mtime = fs.statSync(file).mtimeMs;
  if (cache.file !== file || cache.mtime !== mtime) {
    cache = { file, mtime, data: readSave(file) };
  }
  return cache.data;
}

// Game data: extracted from Melvor2.exe into data/MelvorBase.json, refreshed when the game updates.
const DATA_FILE = path.join(__dirname, 'data', 'MelvorBase.json');
let catalog = null;
let spyglass = null;
function getCatalog() {
  if (catalog) return catalog;
  const exe = findGameExe();
  const stale = !fs.existsSync(DATA_FILE) || (exe && fs.statSync(exe).mtimeMs > fs.statSync(DATA_FILE).mtimeMs);
  if (stale) {
    if (!exe) throw new Error('No game data. Run Extract-Game-Data.cmd once.');
    const { bytes } = readPackFile(exe, 'Data/Packages/MelvorBase.json');
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, bytes);
    console.log('Game data refreshed from', exe);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  catalog = buildCatalog(data);
  combatData = buildCombatData(data);
  bonusData = buildBonusData(data);
  gearData = buildGearData(data);
  astroData = buildAstroData(data);
  // Wiki database, pre-serialized and gzipped once.
  const db = enrichDb(buildDb(data), data);
  wikiGz = zlib.gzipSync(JSON.stringify(db));
  // The in-game planner's data (same shape as the wiki's plan.json); /api/plan lays your own rates over it.
  spyglass = require('./lib/spyglass').buildSpyglass(db);   // the in-game Spyglass lookup
  planBase = { gameVersion: db.gameVersion, items: {}, rates: {} };
  for (const r of Object.values(db.records)) if (r.t === 'Item') planBase.items[r.id] = r.n;
  for (const [id, x] of Object.entries(db.rates || {})) if (x.area !== 'Quests')
    planBase.rates[id] = { id, skill: x.skill, name: x.name, level: x.level, sec: x.sec, xp: x.xp, out: x.out, in: x.in };
  return catalog;
}
let wikiGz = null;
let planBase = null;
let combatData = null, bonusData = null, gearData = null, astroData = null;

// Account bonuses (shop, pets, mastery, astrology) per save version.
let acctCache = { mtime: 0, acct: null };
function getAccount(save) {
  getCatalog();
  if (acctCache.mtime !== save.modified) acctCache = { mtime: save.modified, acct: accountBonuses(bonusData, save) };
  return acctCache.acct;
}

// Combat results are expensive (simulation), so cache them on a fingerprint of only what the combat
// model reads. Skilling (or the XP/progress counters of a fight) leaves it unchanged.
const combatCache = new Map();
const COMBAT_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'];
function combatFingerprint(save, acct) {
  const lv = save.skills.filter(s => COMBAT_SKILLS.includes(s.id)).map(s => s.id + s.level);
  const ranks = Object.entries(acct.ranks).map(([k, r]) => k + r.index);
  const astro = Object.values(save.astrology || {}).map(a => a.minor.length + '.' + a.major.length);
  return require('crypto').createHash('sha1')
    .update(JSON.stringify([save.combat, save.pets, lv, ranks, Object.keys(save.shop || {}), astro, (save.bank?.wallet?.PrayerPoints || 0) > 0]))
    .digest('hex').slice(0, 12);
}
function combatFor(save, loadout) {
  getCatalog();
  const acct = getAccount(save);
  loadout = loadout || save.combat?.activeLoadout;
  const fp = combatFingerprint(save, acct);
  const key = fp + '|' + loadout;
  if (!combatCache.has(key)) {
    if (combatCache.size > 12) combatCache.clear();
    combatCache.set(key, { fingerprint: fp, ...evaluateCombat(combatData, save, { loadout, acct }) });
  }
  return combatCache.get(key);
}

// Combat rows in the money list's shape, best loadout per enemy.
function combatMoney(save, hours) {
  const bank = {};
  for (const t of save.bank.tabs) for (const i of t.items) bank[i.id] = (bank[i.id] || 0) + i.count;
  const best = new Map();
  for (const lid of Object.keys(save.combat?.loadouts || {})) {
    const r = combatFor(save, lid);
    if (r.error) continue;
    for (const row of r.rows) {
      if (row.stuck || !(row.killsPerHour > 0)) continue;
      const net = row.gpPerHour - (row.costPerHour || 0);
      const cur = best.get(row.id);
      if (!cur || net > cur.net) best.set(row.id, { row, net, player: r.player });
    }
  }
  const out = [];
  for (const { row, net, player } of best.values()) {
    const hp = row.playerHp || player.hp;
    const inputs = [];
    const addIn = (id, name, perHour, price) => { if (perHour > 0) { const have = bank[id] ?? 0; inputs.push({ id, name, perHour, value: perHour * price, have, hoursLeft: have / perHour }); } };
    if (row.foodPerHour && player.food) addIn(player.food.id, player.food.name, row.foodPerHour, combatData.price(player.food.id));
    if (row.ammoPerHour && player.ammoId) addIn(player.ammoId, player.ammo, row.ammoPerHour, combatData.price(player.ammoId));
    for (const ru of row.runesPerHour || []) addIn(ru.id, ru.name, ru.qty, combatData.price(ru.id));
    const stockHours = inputs.length ? Math.min(...inputs.map(x => x.hoursLeft)) : Infinity;
    const notes = [...row.notes.filter(n => n !== 'quest'), `${player.loadoutName} loadout`];
    if (row.category === 'Quests' || row.notes.includes('quest')) notes.unshift('quest only');
    if (row.worstTurn >= hp) notes.push('can kill you in one turn');
    if (row.slayer) notes.push(`on task: +${Math.round(row.slayer.coins).toLocaleString()} slayer coins/hr`);
    const outputs = row.drops.map(d => ({ id: d.id, name: d.name, perHour: d.perHour, value: d.perHour * d.value })).filter(d => d.value > 0 || d.perHour > 0).sort((a, b) => b.value - a.value);
    out.push({
      id: 'Combat:' + row.id, skill: 'Combat', name: row.name, area: row.kind === 'dungeon' ? 'Dungeon' : row.area,
      unlocked: !row.missing.length, missing: row.missing, notes,
      seconds: row.kind === 'dungeon' ? row.runSeconds : row.killSeconds + 3, success: row.hitChance,
      gpPerHour: net, sales: row.gpPerHour, inputValue: row.costPerHour || 0, cashPerHour: row.goldPerHour,
      xpPerHour: row.combatXpPerHour, outputs, inputs, stockHours, runHours: Math.min(hours, stockHours),
      totalForHours: net * Math.min(hours, stockHours), unit: row.kind === 'dungeon' ? 'run' : 'kill', gear: [], account: [],
    });
  }
  return out;
}

function moneyFor(save, q) {
  const levels = Object.fromEntries(save.skills.map(s => [s.id, s.level]));
  const bank = {};
  for (const t of save.bank.tabs) for (const i of t.items) bank[i.id] = (bank[i.id] || 0) + i.count;
  const opts = {
    levels, bank, toolbelts: save.toolbelts, acct: getAccount(save), journal: save.journal,
    hours: Math.max(0.1, Number(q.get('hours')) || 8),
    countInputs: q.get('inputs') !== '0', useGear: q.get('gear') !== '0',
  };
  const results = evaluate(getCatalog(), opts);
  // gear=owned|all: re-run each unlocked action with its best toolbelt (per skill, as the game does).
  const mode = q.get('gear');
  if (mode !== 'owned' && mode !== 'all') return results;
  const plans = gearPlans(save, opts, mode, q.get('objective') === 'xp' ? 'xp' : 'gold');
  const cat = getCatalog();
  return results.map(r => {
    const p = plans[r.id];
    if (!p || !r.unlocked) return r;
    const a = cat.actions.find(x => x.id === r.id);
    const items = p.slots.filter(x => x.item).map(x => x.item);
    const r2 = evaluate({ ...cat, actions: [a] }, { ...opts, useGear: true, toolbelts: { ...opts.toolbelts, [a.skill]: items } })[0];
    r2.gpPerHour -= p.potionCost; r2.totalForHours = r2.gpPerHour * r2.runHours;
    return { ...r2, gearPlan: p.slots, gearGain: r2.gpPerHour - r.gpPerHour, xpGain: r2.xpPerHour - r.xpPerHour, potionCost: p.potionCost };
  });
}

// Best toolbelt per unlocked action, cached per save version, mode and objective.
const gearCache = new Map();
let astroCache = { mtime: 0, data: null };
function gearPlans(save, opts, mode, objective) {
  const key = [save.modified, mode, objective, opts.hours, opts.countInputs].join('|');
  if (gearCache.has(key)) return gearCache.get(key);
  const cat = getCatalog();
  const base = evaluate(cat, { ...opts, useGear: true });
  const out = {};
  for (const r of base) if (r.unlocked) out[r.id] = bestGear(cat, gearData, opts, cat.actions.find(a => a.id === r.id), { mode, objective });
  if (gearCache.size > 8) gearCache.clear();
  gearCache.set(key, out);
  return out;
}

// Gear tab: per skill, slots and what's in them, the best plan for the skill's top method, and the not-owned
// items that would add the most gold/hr to that method on top of your best owned set.
function gearReport(save) {
  const cat = getCatalog();
  const levels = Object.fromEntries(save.skills.map(s => [s.id, s.level]));
  const bank = {};
  for (const t of save.bank.tabs) for (const i of t.items) bank[i.id] = (bank[i.id] || 0) + i.count;
  const acct = getAccount(save);
  const opts = { levels, bank, toolbelts: save.toolbelts, acct, journal: save.journal, hours: 8, countInputs: true, useGear: true };
  const owned = gearPlans(save, opts, 'owned', 'gold'), all = gearPlans(save, opts, 'all', 'gold');
  const base = evaluate(cat, opts);
  const names = Object.fromEntries(Object.entries(cat.items).map(([k, v]) => [k, v.name]));
  const skills = {};
  for (const skill of Object.keys(gearData.slots)) {
    if (skill === 'Combat') continue;
    const rows = base.filter(r => r.skill === skill && owned[r.id] && !r.notes.includes('quest only'));
    let top = rows.map(r => ({ r, p: owned[r.id], pa: all[r.id] })).sort((a, b) => b.p.total - a.p.total)[0];
    let objective = 'gold';
    // Skills that only cost gold (firemaking, agility...): rank and optimize by XP instead.
    if (top && top.p.gp < 1000) {
      objective = 'xp';
      top = rows.map(r => { const a = cat.actions.find(x => x.id === r.id); return { r, p: bestGear(cat, gearData, opts, a, { mode: 'owned', objective }), a }; })
        .sort((x, y) => y.p.xp - x.p.xp)[0];
      top.pa = bestGear(cat, gearData, opts, top.a, { mode: 'all', objective });
    }
    const now = currentSlots(gearData, save.toolbelts[skill]);
    const open = openSlots(gearData, skill, acct).map(s => s.id);
    const entry = {
      slots: (gearData.slots[skill] || []).map(s => ({ id: s.id, name: s.name, open: open.includes(s.id), item: now[s.id] || null, itemName: now[s.id] ? names[now[s.id]] || now[s.id] : null })),
      top: top ? { action: top.r.id, name: top.r.name, area: top.r.area, objective, equippedGp: top.p.baseGp, owned: top.p, all: top.pa } : null,
      wishlist: [],
    };
    if (top) {
      const a = cat.actions.find(x => x.id === top.r.id);
      const set = top.p.slots.filter(x => x.item);
      const lvlOk = x => x.levels.every(q => (levels[q.skill] ?? 1) >= q.level);
      for (const s of (gearData.slots[skill] || []).filter(s => open.includes(s.id))) {
        for (const c of gearData.byType[s.type] || []) {
          if (top.p.slots.some(x => x.item === c.id) || (bank[c.id] ?? 0) > 0 || Object.values(save.toolbelts).some(l => l.includes(c.id))) continue;
          const items = set.filter(x => x.slot !== s.id).map(x => x.item).concat(c.id);
          const r = evaluate({ ...cat, actions: [a] }, { ...opts, toolbelts: { ...opts.toolbelts, [skill]: items } })[0];
          const perHour = r.seconds > 0 ? 3600 / r.seconds : 0;
          const gp = r.gpPerHour - (c.stack && c.consumes.length ? c.price * perHour : 0);
          const gain = objective === 'xp' ? 0 : gp - top.p.gp;
          if (gain > 1 || r.xpPerHour - top.p.xp > top.p.xp * 0.005) entry.wishlist.push({ item: c.id, name: c.name, slot: s.name, gain, xpGain: r.xpPerHour - top.p.xp, levelOk: lvlOk(c), levels: c.levels, potion: c.stack && c.consumes.length > 0 });
        }
      }
      entry.wishlist.sort((x, y) => (y.gain > 1) - (x.gain > 1) || y.gain - x.gain || y.xpGain - x.xpGain);
      entry.wishlist = entry.wishlist.filter((w, i, l) => l.findIndex(z => z.item === w.item) === i).slice(0, 12);
    }
    skills[skill] = entry;
  }
  return { modified: save.modified, skills };
}

function passiveFor(save, hours = 8) {
  const levels = Object.fromEntries(save.skills.map(s => [s.id, s.level]));
  const bank = {};
  for (const t of save.bank.tabs) for (const i of t.items) bank[i.id] = (bank[i.id] || 0) + i.count;
  return evaluatePassive(getCatalog(), { levels, bank, toolbelts: save.toolbelts, acct: getAccount(save), farming: save.farming, ranching: save.ranching, hours });
}

// Spreadsheet export: everything the tool knows about the save, plus reference game data.
function buildExport(save) {
  const cat = getCatalog();
  const acct = getAccount(save);
  const levels = Object.fromEntries(save.skills.map(s => [s.id, s.level]));
  const bank = {};
  for (const t of save.bank.tabs) for (const i of t.items) bank[i.id] = (bank[i.id] || 0) + i.count;
  const hours = 8;
  const money = moneyFor(save, new URLSearchParams('hours=8')).concat(combatMoney(save, hours));
  const passive = passiveFor(save, hours);
  const up = upgrades(cat, bonusData, { levels, bank, toolbelts: save.toolbelts, acct, journal: save.journal, farming: save.farming, ranching: save.ranching, wallet: save.bank.wallet });
  const combat = combatFor(save, save.combat?.activeLoadout);
  const price = id => cat.items[id]?.price ?? 0;
  const n = (header, key, num = 'int', width) => ({ header, key, num, width });
  const t = (header, key, width) => ({ header, key, width });
  const f = (header, value, num, width) => ({ header, value, num, width });
  const list = a => (a || []).join('; ');
  const sheets = [];
  sheets.push({ name: 'Skills', columns: [t('Skill', 'name', 16), t('Category', 'category'), n('Level', 'level'), n('XP', 'xp'), n('XP to next', 'xpToNext'), f('Progress', r => r.progress, 'pct'), n('XP to 99', 'xpTo99'),
    f('Mastery rank', r => acct.ranks[r.id]?.rankName || '', null, 24), f('Mastery points', r => acct.ranks[r.id]?.points, 'int'), f('Mastery total', r => acct.ranks[r.id]?.total, 'int')], rows: save.skills });
  const bankRows = save.bank.tabs.flatMap(tab => tab.items.map(i => ({ ...i, tab: tab.name, price: price(i.id), value: price(i.id) * i.count })));
  sheets.push({ name: 'Bank', columns: [t('Item', 'name', 30), t('Id', 'id', 26), t('Tab', 'tab', 14), n('Count', 'count'), n('Sell price', 'price'), n('Total value', 'value')], rows: bankRows });
  const mcols = [t('Method', 'name', 30), t('Skill', 'skill', 13), t('Area', 'area', 22), f('Unlocked', r => r.unlocked ? 'yes' : 'no'), n('Gold/hr', 'gpPerHour'), n('Gold in 8 hr', 'totalForHours'),
    n('XP/hr', 'xpPerHour'), f('Success', r => r.success, 'pct'), n('Seconds per action', 'seconds', 'dec'), n('Sales/hr', 'sales'), n('Inputs cost/hr', 'inputValue'),
    f('Bank lasts (hr)', r => isFinite(r.stockHours) ? r.stockHours : null, 'dec'), f('Produces (per hr)', r => r.outputs.slice(0, 6).map(o => `${o.name} ${Math.round(o.perHour * 10) / 10}`).join('; '), null, 50),
    f('Uses (per hr)', r => r.inputs.map(i => `${i.name} ${Math.round(i.perHour * 10) / 10}`).join('; '), null, 40), f('Missing', r => list(r.missing), null, 24), f('Notes', r => list(r.notes), null, 50)];
  sheets.push({ name: 'Money', columns: mcols, rows: money.filter(r => isFinite(r.gpPerHour)).sort((a, b) => (b.unlocked - a.unlocked) || (b.totalForHours - a.totalForHours)) });
  sheets.push({ name: 'Farming & Ranching', columns: mcols, rows: passive });
  sheets.push({ name: 'Combat (' + (combat.player?.loadoutName || 'active') + ')', columns: [t('Enemy', 'name', 26), t('Area', 'area', 22), t('Kind', 'kind'), f('Unlocked', r => r.missing.length ? 'no' : 'yes'),
    n('Gold/hr', 'gpPerHour'), n('Cost/hr', 'costPerHour'), n('Combat XP/hr', 'combatXpPerHour'), f('Slayer coins/hr (on task)', r => r.slayer?.coins, 'int', 22), f('Slayer XP/hr (on task)', r => r.slayer?.xp, 'int', 20),
    n('Seconds per kill/run', 'killSeconds', 'dec'), n('Kills or runs/hr', 'killsPerHour', 'dec'), f('Hit chance', r => r.hitChance, 'pct'), f('Enemy hit chance', r => r.enemyHitChance, 'pct'),
    n('Food/hr', 'foodPerHour', 'dec'), n('Damage taken/hr', 'takenPerHour'), n('Worst enemy turn', 'worstTurn'), n('Enemy HP', 'hp'), f('Missing', r => list(r.missing), null, 24), f('Notes', r => list(r.notes), null, 30)],
    rows: (combat.rows || []).slice().sort((a, b) => b.gpPerHour - a.gpPerHour) });
  sheets.push({ name: 'Shop upgrades', columns: [t('Upgrade', 'name', 28), t('Category', 'category', 24), f('Estimated', r => r.modelled ? 'yes' : 'no'), n('Gold/hr gain', 'gpGain'), t('Gold skill', 'gpSkill'),
    f('XP gain', r => r.xpPct, 'pct'), t('XP skill', 'xpSkill'), n('Gold cost', 'gold'), n('Total cost', 'cost'), f('Payback (hr)', r => r.paybackHours, 'dec'), f('Can afford', r => r.canAfford ? 'yes' : 'no'),
    f('Items needed', r => r.items.map(i => `${i.qty} ${i.name} (have ${i.have})`).join('; '), null, 34), f('Effect', r => list(r.effects), null, 60)], rows: up.shop.sort((a, b) => b.gpGain - a.gpGain) });
  sheets.push({ name: 'Mastery next ranks', columns: [t('Skill', 'skill'), t('Current rank', 'rank', 22), f('Next rank', r => r.name.split(': ')[1], null, 24), n('Points', 'points'), n('Needed', 'need'), n('To go', 'toGo'),
    n('Gold/hr gain', 'gpGain'), f('XP gain', r => r.xpPct, 'pct'), f('Effect', r => r.noBonus ? 'no bonus yet' : list(r.effects), null, 60)], rows: up.mastery.sort((a, b) => a.toGo - b.toGo) });
  sheets.push({ name: 'Items', columns: [t('Item', 'name', 32), t('Id', 'id', 28), n('Sell price', 'price'), n('In bank', 'have')],
    rows: Object.entries(cat.items).map(([id, it]) => ({ id, name: it.name, price: it.price, have: bank[id] || 0 })).sort((a, b) => a.name.localeCompare(b.name)) });
  const areaOf = new Map();
  for (const a of combatData.areas) for (const e of a.enemies || []) if (!areaOf.has(e)) areaOf.set(e, a.name);
  sheets.push({ name: 'Enemies', columns: [t('Enemy', 'name', 28), t('Area', 'area', 22), n('HP', 'hp'), n('Attack', 'atk'), n('Strength', 'str'), n('Defence', 'def'), n('Ranged', 'rng'), n('Magic', 'mag'),
    n('Attack interval (ms)', 'interval'), t('Style', 'stance'), n('Avg gold/kill', 'gold', 'dec'), n('Avg item value/kill', 'items', 'dec'), n('Special attacks', 'specials'), n('Passives', 'passives')],
    rows: [...combatData.enemies.values()].map(e => ({ name: e.name, area: areaOf.get(e.id) || '', hp: (e.levels.Hitpoints || 1) * 10, atk: e.levels.Attack, str: e.levels.Strength, def: e.levels.Defence,
      rng: e.levels.Ranged, mag: e.levels.Magic, interval: e.stats.AttackInterval, stance: e.stances.map(s => s.id).join('/'), gold: e.drops.gold, items: e.drops.itemValue, specials: e.attacks.length, passives: e.passives.length })) });
  return workbook(sheets);
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/wiki') {
    try {
      getCatalog();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
      res.end(wikiGz);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/combat') {
    try { json(res, 200, combatFor(getSave(), url.searchParams.get('loadout'))); }
    catch (e) { json(res, 500, { error: e.message, stack: e.stack }); }
    return;
  }
  if (url.pathname === '/api/export.xlsx') {
    try {
      const save = getSave();
      const buf = buildExport(save);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="MI2-${save.header.name}-${stamp}.xlsx"`, 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch (e) { json(res, 500, { error: e.message, stack: e.stack }); }
    return;
  }
  if (url.pathname === '/api/upgrades') {
    try {
      const save = getSave();
      const levels = Object.fromEntries(save.skills.map(s => [s.id, s.level]));
      const bank = {};
      for (const t of save.bank.tabs) for (const i of t.items) bank[i.id] = (bank[i.id] || 0) + i.count;
      json(res, 200, { modified: save.modified, ...upgrades(getCatalog(), bonusData, { levels, bank, toolbelts: save.toolbelts, acct: getAccount(save), journal: save.journal, farming: save.farming, ranching: save.ranching, wallet: save.bank.wallet }) });
    } catch (e) { json(res, 500, { error: e.message, stack: e.stack }); }
    return;
  }
  if (url.pathname === '/api/spyglass') {
    // Item sources, uses and unlocks for the in-game Spyglass mod (the same file the wiki publishes).
    try {
      getCatalog();
      json(res, 200, spyglass);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/plan') {
    // Action rates for the Course planner: base rates with your own (gear, upgrades, mastery, bank) on top.
    try {
      getCatalog();
      const rates = { ...planBase.rates };
      let personal = false;
      try {
        for (const a of moneyFor(getSave(), new URLSearchParams())) {
          if (a.passive || !rates[a.id]) continue;
          const b = rates[a.id];
          rates[a.id] = { ...b, sec: a.seconds ?? b.sec, xp: a.xpPerHour ?? b.xp,
            out: (a.outputs || []).map(o => [o.id, o.perHour]), in: (a.inputs || []).map(i => [i.id, i.perHour]) };
          personal = true;
        }
      } catch { /* no save yet: base rates */ }
      json(res, 200, { gameVersion: planBase.gameVersion, personal, items: planBase.items, rates: Object.values(rates) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/money') {
    try {
      const save = getSave();
      let results = moneyFor(save, url.searchParams);
      if (url.searchParams.get('combat') !== '0') results = results.concat(combatMoney(save, Math.max(0.1, Number(url.searchParams.get('hours')) || 8)));
      results = results.concat(passiveFor(save, Math.max(0.1, Number(url.searchParams.get('hours')) || 8)));
      json(res, 200, { modified: save.modified, results });
    }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/icons') {
    // id -> image file, for items, monsters and skills (images from data\img).
    try {
      getCatalog();
      const idx = path.join(__dirname, 'data', 'img', 'index.json');
      const images = fs.existsSync(idx) ? JSON.parse(fs.readFileSync(idx, 'utf8')) : {};
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).Objects;
      const out = { item: {}, enemy: {}, skill: {} };
      const put = (m, id, p) => { const f = p && images[String(p).replace(/^res:\/\//, '')]; if (f) m[id] = f; };
      for (const x of data.Item || []) put(out.item, x.Id, x.Icon);
      for (const x of data.Enemy || []) put(out.enemy, x.Id, x.Sprite || x.Icon);
      for (const t of Object.keys(data)) if (/SkillNavigationOption$/.test(t)) for (const x of data[t]) if (x.Entity) put(out.skill, String(x.Entity).split(':').pop(), x.Icon);
      json(res, 200, out);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/astrology') {
    try {
      const save = getSave(), cat = getCatalog();
      if (astroCache.mtime !== save.modified) {
        const levels = Object.fromEntries(save.skills.map(x => [x.id, x.level]));
        const bank = {}; for (const t of save.bank.tabs) for (const i of t.items) bank[i.id] = (bank[i.id] || 0) + i.count;
        astroCache = { mtime: save.modified, data: astroPlan(cat, astroData, { levels, bank, toolbelts: save.toolbelts, acct: getAccount(save), journal: save.journal, save }) };
      }
      json(res, 200, { modified: save.modified, constellations: astroCache.data, gates: astroData.gates, obsGates: astroData.obsGates, obsChance: astroData.obsChance });
    } catch (e) { json(res, 500, { error: e.message, stack: e.stack }); }
    return;
  }
  if (url.pathname === '/api/gear') {
    try { json(res, 200, gearReport(getSave())); }
    catch (e) { json(res, 500, { error: e.message, stack: e.stack }); }
    return;
  }
  if (url.pathname === '/api/save') {
    try {
      const body = JSON.stringify({ ...getSave(), xpTable: XP_TABLE });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // The wiki's combat calculator runs lib/combat.js in the browser; changes.json is written by build-wiki.js.
  if (url.pathname === '/combat.js' || url.pathname === '/changes.json') {
    const f = url.pathname === '/combat.js' ? path.join(__dirname, 'lib', 'combat.js') : path.join(__dirname, 'data', 'changes.json');
    if (!fs.existsSync(f)) { json(res, 200, []); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)], 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  // Game images (data\img, made by unpack-assets.js) are served under /img/.
  const IMG = path.join(__dirname, 'data', 'img');
  const isImg = url.pathname.startsWith('/img/');
  const root = isImg ? IMG : PUBLIC;
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(isImg ? 5 : 1));
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...(isImg ? { 'Cache-Control': 'max-age=86400' } : {}) });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}`;
  console.log(`Astrolabe Tools running at ${link}`);
  try { console.log('Reading save:', fixedSave || findSave()); } catch {}
  console.log('Leave this window open. Close it to stop.');
  if (process.platform === 'win32' && !process.env.MI2_NO_OPEN) exec(`start "" ${link}`);
});
