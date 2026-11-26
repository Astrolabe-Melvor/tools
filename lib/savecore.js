// Melvor Idle 2 save parser, shared by the local tools (lib/save.js) and the public wiki ("Load my save"),
// which runs it in the browser on the decompressed bytes. Nothing here touches files.
// Save v0.11.7-alpha, save version 32; reads 31 too.
// Format: Brotli-compressed binary. Strings are u8 length + bytes. Numbers are little-endian.
// Layout: header, then i32 component count, then components of
//   str id + i32 byteSize + body, where body = i32 fieldCount + fields (str key + i32 byteSize + bytes).
(function () {

// In the browser, a Uint8Array with the few Buffer methods the readers use.
const SaveBuf = typeof Buffer !== 'undefined' ? null : class SaveBuf extends Uint8Array {
  get dv() { return this._dv || (this._dv = new DataView(this.buffer, this.byteOffset, this.byteLength)); }
  readInt32LE(p) { return this.dv.getInt32(p, true); }
  readBigInt64LE(p) { return this.dv.getBigInt64(p, true); }
  readDoubleLE(p) { return this.dv.getFloat64(p, true); }
  toString(enc, s = 0, e = this.length) {
    const u = this.subarray(s, e);
    if (enc === 'hex') return [...u].map(x => x.toString(16).padStart(2, '0')).join('');
    if (enc === 'latin1') { let r = ''; for (let i = 0; i < u.length; i++) r += String.fromCharCode(u[i]); return r; }
    return new TextDecoder().decode(u);
  }
};

class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.end = end; }
  i32() { const v = this.b.readInt32LE(this.p); this.p += 4; return v; }
  i64() { const v = Number(this.b.readBigInt64LE(this.p)); this.p += 8; return v; }
  f64() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  u8() { return this.b[this.p++]; }
  str() { const n = this.u8(); const s = this.b.toString('utf8', this.p, this.p + n); this.p += n; return s; }
  skip(n) { this.p += n; }
}

function readHeader(r) {
  const version = r.i32();
  const g = r.b.subarray(r.p, r.p + 16); r.skip(16);
  const name = r.str();
  const mode = r.str();
  r.skip(8); // flag + 7 bytes (likely a timestamp, format not yet known)
  const activeSkill = r.str(); r.str(); // skill name, icon path
  const activeAction = r.str(); r.str(); // action name, icon path
  const totalLevel = r.i32();
  const gp = r.i64();
  const slayerCoins = r.i64();
  r.skip(1);
  return { version, saveId: g.toString('hex'), name, mode, activeSkill, activeAction, totalLevel, gp, slayerCoins };
}

function readComponents(r) {
  const count = r.i32();
  const comps = {};
  for (let i = 0; i < count && r.p < r.end; i++) {
    const id = r.str();
    const size = r.i32();
    const start = r.p;
    const fields = {};
    try {
      const fr = new Reader(r.b, start, start + size);
      const nf = fr.i32();
      for (let j = 0; j < nf; j++) {
        const key = fr.str();
        const fsize = fr.i32();
        fields[key] = { start: fr.p, size: fsize };
        fr.skip(fsize);
      }
    } catch { /* keep the fields read so far */ }
    comps[id] = { start, size, fields };
    r.p = start + size;
  }
  return comps;
}

const clean = id => id.replace(/^MelvorBase:/, '');
const pretty = id => clean(id)
  .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  .replace(/\b2 H\b/g, '2H');

// XP curve: matches in-game levels.
const XP_TABLE = [0, 0];
{ let pts = 0; for (let L = 1; L < 120; L++) { pts += Math.floor(L + 300 * 2 ** (L / 7)); XP_TABLE.push(Math.floor(pts / 4)); } }
const levelFor = xp => { let L = 1; while (L < 120 && xp >= XP_TABLE[L + 1]) L++; return L; };

const COMBAT = new Set(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer']);
const PASSIVE = new Set(['Farming', 'Ranching']);

function readSkills(buf, comps) {
  const skills = [];
  for (const [id, c] of Object.entries(comps)) {
    const f = c.fields.Experience;
    if (!f || f.size !== 8) continue;
    const xp = buf.readDoubleLE(f.start);
    const level = levelFor(xp);
    const cur = XP_TABLE[level], next = XP_TABLE[level + 1] ?? cur;
    const name = clean(id);
    skills.push({
      id: name, name: pretty(id), xp, level,
      xpToNext: Math.max(0, next - xp),
      progress: next > cur ? (xp - cur) / (next - cur) : 1,
      xpTo99: Math.max(0, XP_TABLE[99] - xp),
      category: COMBAT.has(name) ? 'Combat' : PASSIVE.has(name) ? 'Passive' : 'Non-Combat',
    });
  }
  return skills;
}

function readBank(buf, comps, version = 31) {
  const bank = comps['MelvorBase:Bank'];
  const out = { tabs: [], wallet: {} };
  if (!bank) return out;
  const inv = bank.fields.Inventory;
  if (inv) {
    const r = new Reader(buf, inv.start, inv.start + inv.size);
    r.i32();
    const nTabs = r.i32();
    for (let t = 0; t < nTabs; t++) {
      r.skip(14); // tab settings
      const n = r.i32();
      const items = [];
      for (let i = 0; i < n; i++) {
        const count = r.i32(); r.skip(2);
        const id = r.str();
        items.push({ id: clean(id), name: pretty(id), count });
      }
      const name = r.str();
      if (r.i32()) { r.skip(2); r.str(); } // tab icon
      // Save v32 (game v0.11.7, "set bank tab icon"): one more byte per tab, then the chosen icon item if it's set.
      if (version >= 32 && r.u8()) r.str();
      out.tabs.push({ name, items });
    }
  }
  const w = bank.fields.Wallet;
  if (w) {
    const r = new Reader(buf, w.start, w.start + w.size);
    const n = r.i32();
    for (let i = 0; i < n; i++) { const amt = r.i64(); out.wallet[clean(r.str())] = amt; }
  }
  return out;
}

// Every MelvorBase id inside each skill's Toolbelt field. Includes slot ids; callers filter to real items.
function readToolbelts(buf, comps) {
  const out = {};
  for (const [id, c] of Object.entries(comps)) {
    const f = c.fields.Toolbelt;
    if (!f) continue;
    const ids = new Set();
    for (let p = f.start; p < f.start + f.size - 12; p++) {
      if (buf[p + 1] === 0x4d && buf.toString('latin1', p + 1, p + 12) === 'MelvorBase:') {
        const n = buf[p];
        if (n > 11 && p + 1 + n <= f.start + f.size) { ids.add(clean(buf.toString('utf8', p + 1, p + 1 + n))); p += n; }
      }
    }
    out[clean(id)] = [...ids];
  }
  return out;
}


// Length-prefixed id tokens in a field, in order. Used where exact layouts are long or vary by loadout.
function tokens(buf, f) {
  const out = [];
  if (!f) return out;
  const end = f.start + f.size;
  for (let p = f.start; p < end; p++) {
    const n = buf[p];
    if (n >= 2 && p + 1 + n <= end) {
      const t = buf.toString('latin1', p + 1, p + 1 + n);
      if (/^[A-Za-z][\w:]*$/.test(t) && /[A-Z]/.test(t)) { out.push({ t: clean(t), p, n }); p += n; }
    }
  }
  return out;
}

// Split a token list into the active loadout (before the first LoadoutN marker) and stored loadouts.
function byLoadout(list) {
  const out = { _active: [] };
  let cur = '_active';
  for (const x of list) {
    if (/^Loadout\d$/.test(x.t)) { cur = x.t; out[cur] = out[cur] || []; continue; }
    out[cur].push(x);
  }
  return out;
}

// Combat setup: active loadout plus stored loadouts. Item/prayer/spell names are raw ids; callers check them against game data.
function readCombat(buf, comps) {
  const c = comps['MelvorBase:Combat'];
  if (!c) return null;
  const F = c.fields;
  const lo = tokens(buf, F.Loadouts);
  const active = lo[0] ? lo[0].t : 'Loadout1';
  const names = {};
  // Loadouts field: id, then i32 size, then display string (u8 len) and a flag, per loadout.
  for (let i = 1; i < lo.length; i++) {
    if (/^Loadout\d$/.test(lo[i].t) && lo[i + 1] && !/^Loadout\d$/.test(lo[i + 1].t)) names[lo[i].t] = lo[i + 1].t;
  }
  const SLOTS = new Set(['Helmet', 'Cape', 'Amulet', 'Ammo', 'Weapon', 'Torso', 'Offhand', 'Legs', 'RingSlot1', 'RingSlot2', 'Gloves', 'Boots', 'Quiver']);
  const equip = {};
  for (const [k, list] of Object.entries(byLoadout(tokens(buf, F.Equipment)))) {
    const slots = {};
    for (let i = 0; i < list.length; i++) {
      if (!SLOTS.has(list[i].t)) continue;
      const nx = list[i + 1];
      if (nx && !SLOTS.has(nx.t)) {
        // slot str, i32 size, i32 quantity, ... then item string
        const qty = buf.readInt32LE(list[i].p + 1 + list[i].n + 4);
        slots[list[i].t] = { item: nx.t, qty };
        i++;
      }
    }
    equip[k] = slots;
  }
  const player = byLoadout(tokens(buf, F.Player));
  // Active loadout stores a weapon-type -> stance map; stored loadouts store a single stance.
  const STYPES = new Set(['Melee', 'Sword', 'Bow', 'Mallet', 'Scimitar', 'Dagger', 'Crossbow', 'Wand', 'Crossbow2H', 'Staff', 'Sword2H', 'Accurate', 'Magic', 'Spear', 'Javelin', 'Boomerang', 'Mace', 'Axe', 'Battlewand', 'Battlestaff', 'Bow2H', 'Longbow', 'Shortbow']);
  const stanceMap = {};
  const act = player._active || [];
  const mi = act.findIndex(x => x.t === 'Melee' && act[act.indexOf(x) + 1] && act[act.indexOf(x) + 1].t !== 'Melee');
  for (let i = Math.max(0, mi); i < act.length - 1; i++) {
    if (STYPES.has(act[i].t) && !STYPES.has(act[i + 1].t)) { stanceMap[act[i].t] = act[i + 1].t; i++; }
  }
  const prayer = byLoadout(tokens(buf, F.Prayer));
  const spells = byLoadout(tokens(buf, F.MagicSpells));
  const belt = byLoadout(tokens(buf, F.Toolbelt));
  const BELT = new Set(['CombatPotion', 'CombatUtility1', 'CombatUtility2']);
  const loadouts = {};
  for (const k of Object.keys(names).length ? Object.keys(names) : ['Loadout1']) {
    const isActive = k === active;
    const src = isActive ? '_active' : k;
    loadouts[k] = {
      id: k, name: names[k] || k, active: isActive,
      equipment: equip[src] || {},
      stance: isActive ? null : ((player[k] || [])[0] || {}).t || null,
      stanceMap: isActive ? stanceMap : null,
      prayers: [...new Set((prayer[src] || []).map(x => x.t).filter(t => !/^CombatSlot|^CombatPrayer$/.test(t)))],
      spells: (spells[src] || []).map(x => x.t),
      toolbelt: (belt[src] || []).map(x => x.t).filter(t => !BELT.has(t)),
    };
  }
  return { activeLoadout: active, loadouts, food: tokens(buf, F.Food).map(x => x.t) };
}

// Pets: per skill, i32 count, then (id, i32 size, bool unlocked, bool hasGoal, ...).
function readPets(buf, comps) {
  const out = [];
  for (const c of Object.values(comps)) {
    const f = c.fields.Pets;
    if (!f) continue;
    try {
      const r = new Reader(buf, f.start, f.start + f.size);
      const n = r.i32();
      for (let i = 0; i < n; i++) { const id = r.str(); const sz = r.i32(); const start = r.p; if (r.u8()) out.push(clean(id)); r.p = start + sz; }
    } catch { /* partial */ }
  }
  return out;
}

// Mastery guild: per skill, optional selected category, i32 task count, then (task id, i32 size, task body).
// Task body: bool hasGoal [str goalId, i32 size, f64 progress, bool complete, bool active], bool triggerMet.
// Returns raw flags per task; whether a task is done also depends on its condition goal, which the
// game re-checks on load (see completedMasteryTasks in combat.js).
function readMastery(buf, comps) {
  const out = {};
  for (const [id, c] of Object.entries(comps)) {
    const f = c.fields.MasteryGuild;
    if (!f) continue;
    const tasks = {};
    try {
      const r = new Reader(buf, f.start, f.start + f.size);
      if (r.u8()) r.str();
      const n = r.i32();
      for (let i = 0; i < n; i++) {
        const tid = r.str(); const sz = r.i32(); const start = r.p;
        const t = { goal: null, trigger: false };
        if (r.u8()) { r.str(); const gs = r.i32(); const gp = r.p; t.progress = r.f64(); t.goal = !!r.u8(); r.p = gp + gs; }
        t.trigger = !!r.u8();
        tasks[clean(tid)] = t;
        r.p = start + sz;
      }
    } catch { /* partial */ }
    out[clean(id)] = tasks;
  }
  return out;
}

// Statistics fields (every component): i32 n simple stats (str id, i32 size, f64), then any number of
// dictionary groups: i32 n, (str id, i32 size, region: i32 count, (f64 value, str key)).
// Returns { statId: number } for simple stats and { statId: { key: number } } for dictionaries.
function readStatistics(buf, comps) {
  const out = {};
  for (const c of Object.values(comps)) {
    const f = c.fields.Statistics;
    if (!f) continue;
    const end = f.start + f.size;
    try {
      const r = new Reader(buf, f.start, end);
      const n = r.i32();
      for (let i = 0; i < n; i++) { const id = clean(r.str()); const sz = r.i32(); const st = r.p; if (sz === 8) out[id] = r.f64(); r.p = st + sz; }
      while (r.p + 4 <= end) {
        const g = r.i32();
        for (let i = 0; i < g; i++) {
          const id = clean(r.str()); const sz = r.i32(); const st = r.p;
          const d = out[id] && typeof out[id] === 'object' ? out[id] : (out[id] = {});
          const m = r.i32();
          for (let k = 0; k < m; k++) { const v = r.f64(); d[clean(r.str())] = v; }
          r.p = st + sz;
        }
      }
    } catch { /* keep what was read */ }
  }
  return out;
}

// Shop: purchases as (i32 quantity, str purchaseId) after an i32 count; read by tokens to skip the header.
function readShop(buf, comps) {
  const f = comps['MelvorBase:Shop']?.fields?.Shop;
  const out = {};
  for (const t of tokens(buf, f)) { const q = buf.readInt32LE(t.p - 4); if (q > 0 && q < 1e7) out[t.t] = q; }
  return out;
}

// Astrology action: per constellation, str id, i32 size, f64 knowledge, i32 n minor node ids, i32 m major node ids.
function readAstrology(buf, comps) {
  const f = comps['MelvorBase:Astrology']?.fields?.Action;
  const out = {};
  const list = tokens(buf, f);
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const sz = buf.readInt32LE(t.p + 1 + t.n);
    if (sz < 16 || sz > 4000) continue;
    const start = t.p + 1 + t.n + 4;
    try {
      const r = new Reader(buf, start, start + sz);
      const knowledge = r.f64();
      const minor = [], major = [];
      const a = r.i32(); for (let k = 0; k < a; k++) minor.push(clean(r.str()));
      const b = r.i32(); for (let k = 0; k < b; k++) major.push(clean(r.str()));
      if (r.p === start + sz) out[t.t] = { knowledge, minor, major };
    } catch { /* not a constellation record */ }
  }
  return out;
}

// Agility techniques: i32 n, (str id, i32 size, f64 xp).
function readTechniques(buf, comps) {
  const f = comps['MelvorBase:Agility']?.fields?.Techniques;
  const out = {};
  if (!f) return out;
  try {
    const r = new Reader(buf, f.start, f.start + f.size);
    const n = r.i32();
    for (let i = 0; i < n; i++) { const id = clean(r.str()); const sz = r.i32(); const st = r.p; out[id] = r.f64(); r.p = st + sz; }
  } catch { /* partial */ }
  return out;
}

// Hunting journal: per animal, str id, i32 size, bool discovered, f64 journal XP, ...
function readJournal(buf, comps) {
  const f = comps['MelvorBase:Hunting']?.fields?.Journal;
  const out = {};
  if (!f) return out;
  try {
    const r = new Reader(buf, f.start, f.start + f.size);
    const n = r.i32();
    for (let i = 0; i < n; i++) { const id = clean(r.str()); const sz = r.i32(); const st = r.p; out[id] = { discovered: !!r.u8(), xp: r.f64() }; r.p = st + sz; }
  } catch { /* partial */ }
  return out;
}

// Farming plots: plot id, i32 size, then bool watered, 4 bools (auto plant/harvest/compost/water),
// bool [selected recipe], bool [selected compost], bool [current compost], state. Unbought plots are 12 bytes.
// Recipe/compost ids are taken as the tokens inside each plot's block; callers check them against game data.
function readFarming(buf, comps) {
  const f = comps['MelvorBase:Farming']?.fields?.Passive;
  const out = [];
  const list = tokens(buf, f);
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const szPos = t.p + 1 + t.n;
    if (szPos + 9 > f.start + f.size) continue;
    const sz = buf.readInt32LE(szPos);
    if (sz < 12 || sz > 2000) continue;
    const body = szPos + 4, end = body + sz;
    const flags = [...buf.subarray(body, body + 5)];
    if (flags.some(b => b > 1)) continue;
    const inner = list.filter(x => x.p > body && x.p < end).map(x => x.t);
    out.push({ plot: t.t, bought: sz > 12, watered: !!flags[0], auto: { plant: !!flags[1], harvest: !!flags[2], compost: !!flags[3], water: !!flags[4] }, ids: inner });
    i += inner.length;
  }
  return out;
}

// Ranching: enclosure tokens followed by animals. Animal: id, i32 size, bool sick, f64 hunger, f64 safety,
// f64 satisfaction, bool wantsPets, i32 petCount, str variant, ...
function readRanching(buf, comps) {
  const f = comps['MelvorBase:Ranching']?.fields?.Passive;
  const out = [];
  let cur = null;
  for (const t of tokens(buf, f)) {
    const szPos = t.p + 1 + t.n;
    const sz = szPos + 4 <= f.start + f.size ? buf.readInt32LE(szPos) : -1;
    // An animal record: size field, then a 0/1 byte and three doubles in 0..2
    if (sz > 30 && sz < 400) {
      const b = szPos + 4;
      const sick = buf[b], hunger = buf.readDoubleLE(b + 1), safety = buf.readDoubleLE(b + 9), sat = buf.readDoubleLE(b + 17);
      if (sick <= 1 && [hunger, safety, sat].every(v => v >= 0 && v <= 3)) {
        if (cur) cur.animals.push({ animal: t.t, sick: !!sick, hunger, safety, satisfaction: sat });
        continue;
      }
    }
    if (/Enclosure|Coop|Hive|Pen|Sty|Hutch|Barn/i.test(t.t)) { cur = { enclosure: t.t, animals: [] }; out.push(cur); }
  }
  return out;
}

// Everything the tools read from a save, from its decompressed bytes.
function parseSave(bytes) {
  const buf = SaveBuf && !(bytes instanceof SaveBuf) ? new SaveBuf(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
  const r = new Reader(buf);
  const header = readHeader(r);
  const comps = readComponents(r);
  const skills = readSkills(buf, comps);
  const bank = readBank(buf, comps, header.version);
  return {
    header, skills, bank, toolbelts: readToolbelts(buf, comps),
    totalLevel: skills.reduce((a, s) => a + s.level, 0),
    components: Object.keys(comps).map(clean),
    combat: readCombat(buf, comps), pets: readPets(buf, comps), mastery: readMastery(buf, comps),
    statistics: readStatistics(buf, comps), shop: readShop(buf, comps), astrology: readAstrology(buf, comps), techniques: readTechniques(buf, comps), journal: readJournal(buf, comps),
    farming: readFarming(buf, comps), ranching: readRanching(buf, comps),
  };
}

const api = { parseSave, XP_TABLE, levelFor, Reader, readHeader, readComponents };
if (typeof module !== 'undefined') module.exports = api; else window.MI2Save = api;
})();
