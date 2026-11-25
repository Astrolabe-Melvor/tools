// Combat calculator. Formulas follow the game's CharacterStats / TargetCharacterStats / CharacterComponent
// (see mi2-mechanics.md "Combat"). Kill time and damage taken come from a seeded simulation per enemy.
const local = id => (id || '').replace(/^MelvorBase:/, '');
// Also loads in the browser (the wiki's combat calculator): no require there, and account checks are skipped.
const { checkCondition } = typeof require === 'function' ? require('./bonuses') : { checkCondition: () => null };
const GOLD = 'MelvorBase:GoldPieces';
const COMBAT_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'];
const SPAWN_MS = 3000;

// ---------- static data ----------
function buildCombatData(data) {
  const o = data.Objects;
  const map = type => new Map((o[type] || []).map(r => [local(r.Id), r]));
  const items = map('Item');
  const price = id => { const it = items.get(local(id)); return it?.SellsFor?.Currency === GOLD ? it.SellsFor.Quantity : 0; };
  const name = id => { const it = items.get(local(id)); const n = it?.DisplayName; return (typeof n === 'string' ? n : n?.Singular) || local(id); };

  // Expected GP of one item, opening chests one level deep.
  const value = id => {
    const it = items.get(local(id));
    const op = it?.Capabilities?.['MelvorBase:Openable'];
    if (!op) return price(id);
    const tot = (op.DropTable || []).reduce((s, r) => s + r.Weight, 0) || 1;
    let v = 0;
    for (const r of op.AlwaysDrops || []) v += price(r.Item) * (r.MinQuantity + r.MaxQuantity) / 2;
    for (const r of op.DropTable || []) v += price(r.Item) * (r.MinQuantity + r.MaxQuantity) / 2 * r.Weight / tot;
    return Math.max(v, price(id));
  };

  const drops = d => {
    const out = [];
    if (!d) return out;
    for (const r of d.FixedItems || []) out.push({ id: local(r.Item), qty: (r.MinQuantity + r.MaxQuantity) / 2, chance: 1 });
    for (const t of d.ItemTables || []) {
      const tot = t.Table.reduce((s, r) => s + r.Weight, 0) || 1;
      for (const r of t.Table) out.push({ id: local(r.Item), qty: (r.MinQuantity + r.MaxQuantity) / 2, chance: t.Chance * r.Weight / tot });
    }
    const gold = (d.FixedCurrencies || []).filter(c => c.Currency === GOLD).reduce((s, c) => s + (c.MinQuantity + c.MaxQuantity) / 2, 0);
    for (const o2 of out) { o2.name = name(o2.id); o2.value = value(o2.id); }
    return { items: out, gold, itemValue: out.reduce((s, x) => s + x.qty * x.chance * x.value, 0) };
  };

  const enemies = new Map();
  for (const e of o.Enemy || []) {
    const lv = Object.fromEntries((e.Levels || []).map(l => [local(l.Key), l.Value]));
    enemies.set(local(e.Id), {
      id: local(e.Id), name: typeof e.DisplayName === 'string' ? e.DisplayName : e.DisplayName?.Singular || local(e.Id),
      levels: lv, stats: Object.fromEntries(e.Stats.Stats.map(s => [local(s.Stat), s.Value])),
      power: Object.fromEntries((e.Stats.PowerRatings || []).map(p => [local(p.DamageType), p.Value])),
      protection: Object.fromEntries((e.Stats.ProtectionRatings || []).map(p => [local(p.DamageType), p.Value])),
      damageType: local(e.DamageType), element: local(e.Element),
      stances: (e.Stances || []).map(s => ({ id: local(s.Stance), w: s.Weight })),
      attacks: (e.Attacks || []).map(a => ({ id: local(a.Attack), chance: a.Chance })),
      passives: (e.Passives || []).map(local),
      drops: drops(e.Drops),
      demoLocked: (e.Requirements || []).some(r => /DemoLocked/.test(r.Type)),
    });
  }

  const areas = [];
  const dungeonIds = new Set((o.Dungeon || []).map(d => d.Id));
  for (const a of [...(o.CombatArea || []), ...(o.Dungeon || [])]) {
    const isD = dungeonIds.has(a.Id);
    areas.push({
      id: local(a.Id), name: a.DisplayName, category: local(a.Category), difficulty: local(a.Difficulty),
      darkness: a.Darkness || 0, effect: a.Effect || null, dungeon: isD,
      enemies: isD ? null : (a.Enemies || []).map(x => local(typeof x === 'string' ? x : x.Enemy)),
      waves: isD ? a.Enemies.map(w => ({ count: w.Count, enemies: w.Enemies.map(x => ({ id: local(x.Enemy), w: x.Weight })) })) : null,
      rewards: isD ? drops(a.Rewards) : null,
      requirements: (a.UnlockRequirements || []).map(r => ({ type: local(r.Type), skill: local(r.Data?.Component?.Entity), level: r.Data?.Level, item: local(r.Data?.Item), raw: r })),
    });
  }

  const slayer = (o.SlayerMaster || []).map(m => ({
    id: local(m.Id), name: m.DisplayName, areas: m.Areas.map(local), baseLength: m.BaseTaskLength,
    level: (m.UnlockRequirements || []).find(r => r.Data?.Level)?.Data.Level || 1,
  }));

  // Mastery guild: tasks and points by skill, rank ladder, rank bonuses.
  const cats = new Map((o.MasteryGuildCategory || []).map(c => [local(c.Id), c.BasePoints]));
  const tasks = new Map((o.MasteryGuildTask || []).map(t => [local(t.Id), cats.get(local(t.Category)) || 0]));
  const taskDefs = new Map((o.MasteryGuildTask || []).map(t => [local(t.Id), t]));
  const mastery = {};
  for (const sk of COMBAT_SKILLS) {
    const cfg = data.EntityConfig['MelvorBase:' + sk] || {};
    const ids = (cfg.MasteryGuildTasks || []).map(x => local(x.Id));
    const ranks = (cfg.MasteryGuildRanks || []).map(x => map('MasteryGuildRank').get(local(x.Id))).filter(Boolean)
      .map(r => ({ id: local(r.Id), frac: r.PointPercentRequired })).sort((a, b) => a.frac - b.frac);
    const bonuses = (cfg.MasteryGuildBonuses || []).map(x => map('MasteryGuildBonus').get(local(x.Id))).filter(Boolean)
      .map(b => ({ rank: local(b.Requirements?.[0]?.Data?.Rank), bonuses: b.Rewards?.Bonuses }));
    mastery[sk] = { tasks: ids, total: ids.reduce((s, t) => s + (tasks.get(t) || 0), 0), ranks, bonuses };
  }

  return {
    items, price, value, name, enemies, areas, slayer, mastery, taskPoints: tasks, taskDefs,
    stances: map('AttackStance'), styles: map('CombatStyle'), statDefs: map('CombatStat'),
    prayers: map('Prayer'), spells: map('MagicSpell'), attacks: map('Attack'), passives: map('CombatPassive'),
    dots: new Map([...(o.DamageOverTimeEffect || []), ...(o.BleedEffect || [])].filter(d => d.DamagePerProc).map(d => [local(d.Id), d])), stuns: map('StunEffect'),
    pets: map('Pet'), sets: o.EquipmentSetBonus || [], triangle: o.CombatTriangleBonus || [], elemental: o.ElementalBonus || [],
  };
}

// ---------- modifiers ----------
// A modifier: { name, type, value, ctx, owner } where owner is 'Player' | 'Enemy' | other component.
function collect(list, bonuses, mult = 1, src = '') {
  if (!bonuses) return;
  for (const m of bonuses.Component || []) {
    if (m.Condition || m.Scaling) { list.skipped = (list.skipped || 0) + 1; continue; }
    const lc = m.LocalContext || {};
    list.push({
      name: m.Stat?.Name, type: local(m.Stat?.StatsType), value: m.Value * mult, src,
      owner: lc.Component?.Component, entity: local(lc.Component?.Entity),
      ctx: { style: local(lc.CombatStyle), stance: local(lc.AttackStance), level: local(lc.CombatLevel), stat: local(lc.CombatStat),
        dtype: local(lc.DamageType), element: local(lc.Element) },
    });
  }
}

function sum(mods, owner, name, ctx = {}, key = {}) {
  let s = 0;
  for (const m of mods) {
    if (m.name !== name) continue;
    if (owner && m.owner && m.owner !== owner) continue;
    const c = m.ctx;
    if (c.style && c.style !== ctx.style) continue;
    if (c.stance && c.stance !== ctx.stance) continue;
    if (c.element && c.element !== ctx.element) continue;
    if (c.dtype && c.dtype !== (key.dtype || ctx.dtype)) continue;
    if (c.stat && c.stat !== key.stat) continue;
    if (c.level && c.level !== key.level) continue;
    if (!c.stat && key.stat) continue;
    if (!c.level && key.level) continue;
    s += m.value;
  }
  return s;
}

// ---------- character stats ----------
function lvlSum(ratios, levels) { return (ratios || []).reduce((s, r) => s + (levels[local(r.Level)] || 1) * r.Ratio, 0); }

function deriveStats(cd, who, { levels, baseStats, power, protection, stance, element, mods, owner, darkness = 0, ctxExtra = {} }) {
  const st = cd.stances.get(stance);
  const style = cd.styles.get(local(st?.CombatStyle)) || cd.styles.get('Melee');
  const ctx = { style: local(style.Id), stance, element, ...ctxExtra };
  const S = (n, key) => sum(mods, owner, n, ctx, key);
  const stats = {};
  for (const [id, def] of cd.statDefs) {
    let v = ((baseStats[id] || 0) + S('FlatCombatStatValue', { stat: id })) * (1 + S('PercentCombatStatValue', { stat: id }));
    if (!def.IsPercent) v = Math.round(v);
    if (!def.AllowNegative) v = Math.max(0, v);
    stats[id] = v;
  }
  const lv = {};
  for (const k of ['Hitpoints', 'Attack', 'Strength', 'Defence', 'Ranged', 'Magic']) lv[k] = Math.trunc((levels[k] || 1) + S('FlatCombatLevel', { level: k }));
  const dark = Math.min(20, Math.max(0, Math.trunc(darkness * (1 + S('PercentDarkness')) + S('FlatDarkness') - S('FlatLight'))));
  const darkMul = 1 - 0.05 * dark;
  const accBase = Math.floor((lvlSum(style.AccuracyRatingLevels, lv) + 9) * (stats[local(st.AccuracyStat)] + 64));
  const accuracy = Math.max(1, Math.trunc(Math.floor(accBase * (1 + S('PercentAccuracyRating'))) * darkMul));
  // Evasion is per attacker stance: the attacker's stance picks the defence stat and level mix.
  const evasion = {};
  for (const [sid, s2] of cd.stances) {
    const st2 = cd.styles.get(local(s2.CombatStyle));
    const base = Math.floor((lvlSum(st2.EvasionLevels, lv) + 9) * (stats[local(s2.EvasionStat)] + 64));
    evasion[sid] = Math.max(1, Math.trunc(Math.floor(base * (1 + S('PercentEvasionRating')) + S('FlatEvasionRating')) * darkMul));
  }
  const f = style.MaxHitFormula;
  const L = lvlSum(f.Data.Levels, lv);
  const baseMax = local(f.Type) === 'StrengthBonus'
    ? Math.floor(22 + L + (L + 17) * stats[local(f.Data.StrengthBonusStat)] / 64)
    : Math.floor(stats[local(f.Data.MaxHitStat)] * (1 + stats[local(f.Data.DamageBonusStat)]) * (1 + (L + 1) / 200));
  const maxHit = Math.max(1, Math.floor((baseMax * (1 + S('PercentMaxHit')) + S('FlatMaxHit')) * (1 + S('MaxHitCombatTriangle'))));
  const minHit = Math.min(maxHit, Math.max(1, Math.floor(1 + S('FlatMinHit') + maxHit * S('MinHitBasedOnMaxHit'))));
  const interval = Math.max(250, Math.floor((stats[local(style.AttackIntervalStat)] || 3000) * (1 + S('PercentAttackInterval')) + S('FlatAttackInterval')));
  const hp = Math.max(1, Math.floor(lv.Hitpoints * 10 * (1 + S('PercentMaxHitpoints')) + S('FlatMaxHitpoints')));
  const pw = {}, pr = {};
  for (const d of new Set([...Object.keys(power), 'Normal'])) pw[d] = Math.max(1, Math.trunc(((power[d] || 0) + S('FlatPowerRating', {})) * (1 + S('PercentPowerRating'))));
  for (const d of new Set([...Object.keys(protection), 'Normal'])) pr[d] = Math.max(0, Math.trunc(((protection[d] || 0) + S('FlatProtectionRating')) * (1 + S('PercentProtectionRating'))));
  return {
    who, style: ctx.style, stance, element, levels: lv, stats, accuracy, evasion, maxHit, minHit, interval, hp,
    power: pw, protection: pr, armour: stats[local(style.ArmourStat)] || 0, ward: stats[local(style.MaxWardStat)] || 0,
    critChance: Math.min(1, Math.max(0, S('FlatCriticalHitChance'))), critMult: Math.max(1, 1.5 + S('FlatCriticalHitMultiplier')),
    dmgDealt: S('PercentDamageDealt'), dmgTaken: S('PercentDamageTaken'), negate: S('AttackDamageNegationChance'),
    lifesteal: Math.max(0, stats[local(style.LifestealStat)] || 0), darkness: dark, mods, owner, ctx,
  };
}

// Defender resistance against an attacker (TargetCharacterStats.Resistance): defender-side modifiers.
function resistance(att, def, dtype) {
  const ctx = def.ctx;
  const flat = sum(def.mods, def.owner, 'FlatResistance', ctx, { dtype });
  const pct = sum(def.mods, def.owner, 'PercentResistance', ctx, { dtype });
  const tri = sum(def.mods, def.owner, 'ResistanceCombatTriangle', ctx, { dtype });
  const p = att.power[dtype] || 1, q = def.protection[dtype] || 0;
  return Math.min(1, Math.max(0, Math.min(0.7, Math.max(0, (q / (p + q) + flat) * (1 + pct))) * (1 + tri)));
}

function hitChance(att, def) {
  const ev = def.evasion[att.stance] || 1, acc = att.accuracy;
  const flat = sum(att.mods, att.owner, 'FlatHitChance', att.ctx);
  return Math.min(1, Math.max(0, (acc >= ev ? 1 - ev / 2 / acc : acc / 2 / ev) + flat));
}

// ---------- simulation ----------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// Attack list for a character: specials with their chances, default Normal fills the rest.
// Compiled to plain objects so the simulation loop does no string work.
// On-hit effects modelled: damage over time and stuns. Buff/debuff effects (turn counting, stacking) are not.
const KIND = { NormalDamage: 0, MaxHit: 1, CurrentHitpoints: 2, DamageDealt: 3 };
function compileEffect(cd, e) {
  const t = local(e.Effect?.Type);
  if (t === 'DamageOverTime') {
    const d = cd.dots.get(local(e.Effect.Data?.Effect));
    if (!d) return null;
    const f = d.DamagePerProc?.Formula;
    return { kind: 'dot', id: local(d.Id), every: d.ProcInterval, count: Math.min(d.ProcCount, 200), max: d.MaxStacks || 1,
      fk: KIND[local(f?.Type)] ?? 1, p: f?.Data?.Percent ?? 0, onTarget: d.DamagePerProc?.Character !== 'Source', chance: e.Chance ?? 1 };
  }
  if (t === 'Stun') {
    const st = cd.stuns.get(local(e.Effect.Data?.Effect));
    return { kind: 'stun', turns: e.Effect.Data?.Configuration?.Turns ?? st?.DefaultTurns ?? 1, chance: e.Chance ?? 1 };
  }
  return null;
}
function compile(cd, a, extra = []) {
  const onHit = [...(a.OnHitEffects || []).filter(e => e.AppliesTo !== 'Self').map(e => compileEffect(cd, e)), ...extra].filter(Boolean);
  return {
    id: local(a.Id), avoidable: a.IsAvoidable !== false, onHit,
    hits: a.Hits.map(h => ({ count: h.Count, dmg: h.Damage.map(d => ({ def: d.Character === 'Defender', kind: KIND[local(d.Formula.Type)] ?? 1, p: d.Formula.Data?.Percent ?? 1 })) })),
  };
}
// Passive effects of a character: on-hit ones ride on every attack, when-hit ones fire when it is hit.
function passiveEffects(cd, ids) {
  const onHit = [], whenHit = [];
  for (const id of ids) for (const c of cd.passives.get(id)?.Modifiers?.CombatEffect || []) {
    const tr = local(c.Modifier?.Trigger?.Type), tt = c.Modifier?.Trigger?.Data?.Type;
    if (c.Modifier?.AppliesTo === 'Self' || c.Condition) continue;
    const eff = compileEffect(cd, { Effect: c.Modifier.Effect, Chance: c.Chance });
    if (!eff) continue;
    if (tr === 'OnAttack' && tt === 'OnHit') onHit.push(eff);
    else if (tr === 'WhenAttacked' && tt === 'WhenHit') whenHit.push(eff);
  }
  return { onHit, whenHit };
}
function attackTable(cd, specials, extra = []) {
  const list = [];
  let tot = 0;
  for (const s of specials) { const a = cd.attacks.get(s.id); if (a) { list.push({ a: compile(cd, a, extra), chance: s.chance }); tot += s.chance; } }
  if (tot < 1) list.unshift({ a: compile(cd, cd.attacks.get('Normal'), extra), chance: 1 - tot });
  return list;
}
function pick(r, table) { if (table.length === 1) return table[0].a; const x = r(); let c = 0; for (const t of table) { c += t.chance; if (x < c) return t.a; } return table[0].a; }

// Damage after the defender's reductions (CharacterComponent.ModifyAttackDamage / ModifyEffectDamage).
function reduce(d, att, def, mx, st, isAttack) {
  let n = d * (1 + att.dmgDealt) * (1 + def.dmgTaken + mx.takenFrom) * (1 - mx.res);
  if (!st.armourBroken) n -= def.armour;
  const mod = Math.trunc(Math.max(n, 1));
  if (isAttack && def.armour > 0 && mod >= def.armour) st.armourBroken = true;
  return mod;
}

// side = { S: stats, st: state {hp, max, armourBroken, dots, stun}, mx, table, whenHit }
function applyEffect(r, e, src, dst, hitDmg, now) {
  if (r() >= e.chance) return;
  if (e.kind === 'stun') { dst.st.stun = Math.max(dst.st.stun, e.turns); return; }
  const cur = dst.st.dots.get(e.id);
  const per = () => Math.max(1, Math.trunc(e.fk === 3 ? hitDmg * e.p : e.fk === 2 ? (e.onTarget ? dst.st.hp : src.st.hp) * e.p : src.S.maxHit * e.p));
  if (cur) { if (cur.stacks >= e.max) return; cur.stacks++; cur.per += per(); return; }
  dst.st.dots.set(e.id, { stacks: 1, per: per(), left: e.count, next: now + e.every, every: e.every, src });
}

// One attack turn of `a` by A on D. Returns HP damage dealt by the attack itself.
function doAttack(r, atk, A, D, now) {
  let dealt = 0;
  for (const h of atk.hits) {
    for (let k = 0; k < h.count; k++) {
      if (atk.avoidable && r() >= A.mx.hit) continue;
      let d = 0;
      for (const dm of h.dmg) {
        const who = dm.def ? D.S : A.S;
        if (dm.kind === 0) { const lo = Math.trunc(who.minHit * dm.p), hi = Math.trunc(who.maxHit * dm.p); d += lo + Math.floor(r() * (hi - lo + 1)); }
        else if (dm.kind === 2) d += Math.trunc((dm.def ? D.st.hp : A.st.hp) * dm.p);
        else d += Math.trunc(who.maxHit * dm.p);
      }
      if (A.S.critChance && r() < A.S.critChance) d = Math.trunc(d * A.S.critMult);
      if (D.S.negate && r() < D.S.negate) d = 0;
      if (d <= 0) continue;
      const mod = reduce(d, A.S, D.S, A.mx, D.st, true);
      const real = Math.min(mod, D.st.hp);
      D.st.hp -= real; dealt += real;
      if (A.S.lifesteal > 0 && real > 0) A.st.hp = Math.min(A.st.max, A.st.hp + Math.max(1, Math.trunc(real * A.S.lifesteal)));
      for (const e of atk.onHit) applyEffect(r, e, A, D, real, now);
      for (const e of D.whenHit) applyEffect(r, e, D, A, real, now);
      if (D.st.hp <= 0) return dealt;
    }
  }
  return dealt;
}

function simulate(cd, P, E, pTable, eTable, mxP, mxE, n, seed, eWhenHit = []) {
  const r = rng(seed);
  let time = 0, taken = 0, pTurns = 0, maxTurn = 0, eTurns = 0, dealtAttack = 0;
  const ps = { hp: P.hp, max: P.hp, armourBroken: false, dots: new Map(), stun: 0 };
  const es = { hp: E.hp, max: E.hp, armourBroken: false, dots: new Map(), stun: 0 };
  const PL = { S: P, st: ps, mx: mxP, whenHit: [] }, EN = { S: E, st: es, mx: mxE, whenHit: eWhenHit };
  let now = 0;
  for (let i = 0; i < n; i++) {
    es.hp = E.hp; es.armourBroken = false; es.dots.clear(); es.stun = 0;
    ps.armourBroken = false; ps.stun = 0;
    const start = now;
    let tp = now + P.interval, te = now + E.interval, guard = 0;
    while (es.hp > 0 && guard++ < 20000) {
      // next event: player turn, enemy turn, or a damage-over-time tick on either side
      let tDot = Infinity, dotOwner = null, dotKey = null;
      if (ps.dots.size) for (const [k, d] of ps.dots) if (d.next < tDot) { tDot = d.next; dotOwner = PL; dotKey = k; }
      if (es.dots.size) for (const [k, d] of es.dots) if (d.next < tDot) { tDot = d.next; dotOwner = EN; dotKey = k; }
      if (tDot < tp && tDot < te) {
        now = tDot;
        const d = dotOwner.st.dots.get(dotKey);
        const att = dotOwner === PL ? EN : PL;
        const before = dotOwner.st.hp;
        dotOwner.st.hp -= Math.min(reduce(d.per, att.S, dotOwner.S, att.mx, dotOwner.st, false), dotOwner.st.hp);
        if (dotOwner === PL) { taken += before - ps.hp; ps.hp = P.hp; }
        if (--d.left <= 0) dotOwner.st.dots.delete(dotKey); else d.next += d.every;
        continue;
      }
      if (tp <= te) {
        now = tp; tp += P.interval;
        if (ps.stun > 0) { ps.stun--; continue; }
        pTurns++;
        dealtAttack += doAttack(r, pick(r, pTable), PL, EN, now);
      } else {
        now = te; te += E.interval;
        if (es.stun > 0) { es.stun--; continue; }
        eTurns++;
        ps.hp = P.hp; // auto-eat assumed: damage counted, player kept topped up
        const dealt = doAttack(r, pick(r, eTable), EN, PL, now);
        taken += dealt; if (dealt > maxTurn) maxTurn = dealt;
        ps.hp = P.hp;
      }
    }
    if (es.hp > 0) return { stuck: true, killMs: Infinity, takenPerKill: 0, pTurnsPerKill: 0, eTurnsPerKill: 0, maxTurnSeen: maxTurn, dmgPerKill: 0 };
    time += now - start;
    // respawn gap: damage over time on the player keeps ticking
    const gapEnd = now + SPAWN_MS;
    for (const [k, d] of ps.dots) {
      while (d.left > 0 && d.next <= gapEnd) { taken += Math.min(reduce(d.per, E, P, mxE, ps, false), P.hp); d.left--; d.next += d.every; }
      if (d.left <= 0) ps.dots.delete(k);
    }
    now = gapEnd;
  }
  return { killMs: time / n, takenPerKill: taken / n, pTurnsPerKill: pTurns / n, eTurnsPerKill: eTurns / n, maxTurnSeen: maxTurn, dmgPerKill: dealtAttack / n };
}

// Worst single enemy turn: every hit lands at max.
function worstTurn(cd, eTable, E, P, res) {
  let w = 0;
  for (const { a } of eTable) {
    let d = 0;
    for (const h of a.hits) for (let k = 0; k < h.count; k++) for (const dm of h.dmg) {
      const p = dm.p;
      const base = dm.kind === 2 ? P.hp * p : E.maxHit * p;
      d += Math.max(1, Math.trunc(base * (1 + E.critChance * 0) * (1 + E.dmgDealt) * (1 + P.dmgTaken) * (1 - res) - P.armour));
    }
    w = Math.max(w, d);
  }
  return w;
}

// ---------- player setup from save ----------
// A task is done when its goal is complete, its condition holds and its trigger has fired (each only if present).
// Conditions we can check from the save: Level and PetUnlocked. Others (kill/task statistics) count as not met,
// so ranks here are a lower bound.
function completedMasteryTasks(cd, raw, levels, pets) {
  const done = [];
  let unknown = 0;
  for (const [tid, st] of Object.entries(raw || {})) {
    const def = cd.taskDefs.get(tid);
    if (!def) continue;
    if (def.Goal && !st.goal) continue;
    if (def.TriggerGoal && !st.trigger) continue;
    const cg = def.ConditionGoal;
    if (cg) {
      const t = local(cg.Type), d = cg.Data || {};
      if (t === 'Level') { if ((levels[local(d.Component?.Entity)] || 1) < d.Level) continue; }
      else if (t === 'PetUnlocked') { if (!pets.includes(local(d.Pet))) continue; }
      else { unknown++; continue; }
    }
    done.push(tid);
  }
  return { done, unknown };
}

function masteryRank(cd, sk, raw, levels, pets) {
  const m = cd.mastery[sk];
  if (!m) return null;
  const { done, unknown } = completedMasteryTasks(cd, raw, levels, pets);
  const pts = done.reduce((s, t) => s + (cd.taskPoints.get(t) || 0), 0);
  let rank = m.ranks[0];
  for (const r of m.ranks) if (pts >= Math.ceil(m.total * r.frac)) rank = r;
  return { points: pts, total: m.total, rank: rank?.id, index: m.ranks.indexOf(rank), unchecked: unknown };
}

function playerSetup(cd, save, loadoutId, acct) {
  const levels = Object.fromEntries((save.skills || []).map(s => [s.id, s.level]));
  const lo = save.combat?.loadouts?.[loadoutId] || Object.values(save.combat?.loadouts || {})[0];
  if (!lo) return null;
  const notes = [];
  const mods = []; mods.skipped = 0;
  const baseStats = {}, power = {}, protection = {};
  const equipped = [];
  for (const [slot, e] of Object.entries(lo.equipment)) {
    if (e.qty < 0) continue; // slot occupied by a two-handed item
    const it = cd.items.get(e.item);
    const eq = it?.Capabilities?.['MelvorBase:Equipment'];
    if (!eq) continue;
    equipped.push({ slot, id: e.item, name: cd.name(e.item), qty: e.qty });
    for (const s of eq.Stats?.Stats || []) baseStats[local(s.Stat)] = (baseStats[local(s.Stat)] || 0) + s.Value;
    for (const p of eq.Stats?.PowerRatings || []) power[local(p.DamageType)] = (power[local(p.DamageType)] || 0) + p.Value;
    for (const p of eq.Stats?.ProtectionRatings || []) protection[local(p.DamageType)] = (protection[local(p.DamageType)] || 0) + p.Value;
    collect(mods, eq.Bonuses, 1, cd.name(e.item));
  }
  // Set pieces count from equipment and the toolbelt (the game counts both since v0.11.7).
  const ids = new Set([...equipped.map(e => e.id), ...(lo.toolbelt || [])]);
  for (const set of cd.sets) {
    const n = set.Items.filter(i => ids.has(local(i))).length;
    for (const b of set.Bonuses || []) if (n >= b.ItemCount) collect(mods, b.Modifiers, 1, local(set.Id) + ' set');
  }
  const weaponId = lo.equipment.Weapon?.item;
  const weapon = cd.items.get(weaponId)?.Capabilities?.['MelvorBase:Weapon'];
  const wType = local(weapon?.Type);
  let stance = lo.stance || lo.stanceMap?.[wType] || (cd.stances.has('Stab') ? 'Stab' : null);
  const style = local(cd.stances.get(stance)?.CombatStyle);
  let element = local(weapon?.Elements?.[0]) || 'Neutral';
  let spell = null;
  if (style === 'Magic') {
    const names = (lo.spells || []).filter(s => cd.spells.has(s));
    // Prefer a spell matching the staff element, else the last one listed.
    spell = names.find(s => local(cd.spells.get(s).Element) === element) || names[names.length - 1] || null;
    if (spell) {
      const sp = cd.spells.get(spell);
      element = local(sp.Element);
      for (const s of sp.Stats?.Stats || []) baseStats[local(s.Stat)] = (baseStats[local(s.Stat)] || 0) + s.Value;
    } else notes.push('no spell selected');
  }
  collect(mods, cd.stances.get(stance)?.Bonuses, 1, 'stance');
  let prayers = (lo.prayers || []).filter(p => cd.prayers.has(p));
  if (prayers.length && !(save.bank?.wallet?.PrayerPoints > 0)) { notes.push(`prayer ${prayers.join(', ')} off: 0 prayer points`); prayers = []; }
  for (const p of prayers) collect(mods, cd.prayers.get(p).Bonuses, 1, 'prayer ' + p);
  for (const t of lo.toolbelt || []) collect(mods, cd.items.get(t)?.Capabilities?.['MelvorBase:Toolbelt']?.Bonuses, 1, cd.name(t));
  const food = (save.combat?.food || []).find(f => cd.items.get(f)?.Capabilities?.['MelvorBase:Food']);
  const foodCap = food && cd.items.get(food).Capabilities['MelvorBase:Food'];
  if (foodCap) collect(mods, foodCap.Bonuses?.Modifiers, 1, 'food');
  // Shop purchases, pets, mastery ranks and astrology nodes (lib/bonuses.js).
  if (acct) for (const e of acct.entries) if (e.m) collect(mods, { Component: [e.m] }, e.mult, e.src);
  const mastery = acct ? acct.ranks : {};
  const ammo = lo.equipment.Ammo?.item || null;
  return { loadout: lo, levels, baseStats, power, protection, mods, stance, style, element, spell, prayers, food, foodCap, equipped, ammo, weapon: weaponId, notes, mastery };
}

// ---------- evaluation ----------
function evaluateCombat(cd, save, { loadout, sims = 300, acct = null } = {}) {
  const ps = playerSetup(cd, save, loadout || save.combat?.activeLoadout, acct);
  if (!ps) return { error: 'No combat loadout found in save' };
  const slayerLevel = ps.levels.Slayer || 1;
  const masterByArea = new Map();
  for (const m of cd.slayer) for (const a of m.areas) masterByArea.set(a, m);
  const globalXp = (acct?.entries || []).filter(e => e.global === 'GlobalPercentXpGained').reduce((s2, e) => s2 + e.value, 0);
  const xpMult = sk => 1 + globalXp + ps.mods.filter(m => m.name === 'PercentXPGained' && m.entity === sk).reduce((s2, m) => s2 + m.value, 0);
  const stanceXp = (cd.stances.get(ps.stance)?.ExperienceGain || []).map(x => ({ skill: local(x.Component.Entity), perDmg: x.ExperiencePerDamage }));
  const slayerCoinPct = ps.mods.filter(m => m.name === 'PercentRewardCurrency').reduce((s, m) => s + m.value, 0);
  const slayerCoinFlat = ps.mods.filter(m => m.name === 'FlatRewardCurrency').reduce((s, m) => s + m.value, 0);
  const foodHeal = ps.foodCap ? Math.max(1, Math.floor(ps.foodCap.BaseHealing * (1 + sum(ps.mods, 'Player', 'PercentHealing')) + sum(ps.mods, 'Player', 'FlatHealing'))) : 0;
  const prayerCost = ps.prayers.reduce((s, p) => s + (cd.prayers.get(p).Cost?.Quantity || 0), 0);
  const runeCost = ps.spell ? (cd.spells.get(ps.spell).RuneCosts || []).map(rc => ({ id: local(rc.Item), qty: rc.Quantity })) : [];
  const ammoPres = sum(ps.mods, null, 'AmmoPreservationChance');
  const runePres = sum(ps.mods, null, 'RunePreservationChance');

  const nm = id => cd.enemies.get(local(id))?.name || cd.areas.find(a => a.id === local(id))?.name || local(id).replace(/([a-z])([A-Z])/g, '$1 $2');
  const reqLabel = r => {
    const t = local(r.Type), d = r.Data || {};
    if (t === 'EnemyStatistic') return `kill ${nm(d.Enemy)} x${d.Value}`;
    if (t === 'DungeonStatistic') return `clear ${nm(d.Dungeon)} x${d.Value}`;
    if (t === 'SlayerMasterStatistic') return `${d.Value} ${local(d.Master)} tasks`;
    if (t === 'AgilityTechniqueLevel') return `${local(d.Technique)} technique ${d.Level}`;
    if (t === 'ShopPurchase') return `buy ${local(d.ShopPurchase).replace(/([a-z])([A-Z])/g, '$1 $2')}`;
    return t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  };
  const reqState = reqs => {
    const missing = [], notes = [];
    for (const q of reqs || []) {
      const known = acct && !/ItemEquipped$/.test(q.type) ? checkCondition(q.raw, acct.ctx) : null;
      if (known === true) continue;
      if (q.type === 'Level') { if ((ps.levels[q.skill] || 1) < q.level) missing.push(`${q.skill} ${q.level}`); }
      else if (known === false && /^Quest/.test(q.type)) missing.push('quest step');
      else if (known === false) missing.push(reqLabel(q.raw));
      else if (q.type === 'ToolbeltItemEquipped' || q.type === 'EquipmentItemEquipped') notes.push('needs ' + cd.name(q.item));
      else if (/^Quest/.test(q.type)) notes.push('quest');
      else if (q.type === 'AgilityTechniqueLevel') notes.push('agility technique');
      else if (/Statistic$/.test(q.type)) notes.push('kill/task unlock');
      else notes.push(q.type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
    }
    return { missing, notes: [...new Set(notes)] };
  };
  const foodPrice = ps.food ? cd.price(ps.food) : 0;
  const ammoPrice = ps.ammo ? cd.price(ps.ammo) : 0;
  const costOf = (foodHr, ammoHr, runesHr) => (foodHr || 0) * foodPrice + (ammoHr || 0) * ammoPrice + (runesHr || []).reduce((s2, r) => s2 + r.qty * cd.price(r.id), 0);

  // Shop "Area Effect Removal" purchases switch off a slayer zone's effect.
  const disabledAreas = new Set((acct?.entries || []).filter(e => e.m?.Stat?.Name === 'DisableAreaEffect')
    .map(e => local(e.m.LocalContext?.Area || e.m.LocalContext?.CombatArea || '')).filter(Boolean));
  const cache = new Map();
  const fight = (area, enemyId) => {
    const key = (area?.id || '') + ':' + enemyId;
    if (cache.has(key)) return cache.get(key);
    const e = cd.enemies.get(enemyId);
    if (!e) return null;
    // Per-fight modifier sets: player base + triangle/elemental + area effect; enemy passives + area effect.
    const pm = ps.mods.slice(); pm.skipped = ps.mods.skipped;
    const em = []; em.skipped = 0;
    const eStanceTop = [...e.stances].sort((a, b) => b.w - a.w)[0]?.id;
    const eStyle = local(cd.stances.get(eStanceTop)?.CombatStyle);
    for (const t of cd.triangle) if (local(t.PlayerStyle) === ps.style && local(t.EnemyStyle) === eStyle) collect(pm, t.Bonuses, 1, 'triangle');
    for (const t of cd.elemental) if (local(t.PlayerElement) === ps.element && local(t.EnemyElement) === e.element) collect(pm, t.Bonuses, 1, 'element');
    if (area?.effect && !disabledAreas.has(area.id)) { const mag = area.effect.Magnitude || 1; collect(pm, area.effect.Modifiers, mag, 'area'); collect(em, area.effect.Modifiers, mag, 'area'); }
    for (const p of e.passives) collect(em, cd.passives.get(p)?.Modifiers, 1, 'passive');
    const P = deriveStats(cd, 'player', { levels: ps.levels, baseStats: ps.baseStats, power: ps.power, protection: ps.protection, stance: ps.stance, element: ps.element, mods: pm, owner: 'Player', darkness: area?.darkness || 0 });
    const pe = passiveEffects(cd, e.passives);
    const eTable = attackTable(cd, e.attacks, pe.onHit);
    const pTable = attackTable(cd, []);
    // Enemy stats for each of its stances, weighted. Most enemies have one stance.
    const tw = e.stances.reduce((s, x) => s + x.w, 0) || 1;
    let agg = null;
    for (const s of e.stances.length ? e.stances : [{ id: 'Stab', w: 1 }]) {
      const E = deriveStats(cd, 'enemy', { levels: e.levels, baseStats: e.stats, power: e.power, protection: e.protection, stance: s.id, element: e.element, mods: em, owner: 'Enemy' });
      const mxP = { hit: hitChance(P, E), res: resistance(P, E, local(cd.items.get(ps.weapon)?.Capabilities?.['MelvorBase:Weapon']?.DamageType) || 'Normal'), takenFrom: sum(em, 'Enemy', 'PercentDamageTakenFrom', P.ctx) };
      const mxE = { hit: hitChance(E, P), res: resistance(E, P, e.damageType || 'Normal'), takenFrom: sum(pm, 'Player', 'PercentDamageTakenFrom', E.ctx) };
      // Cap simulated player turns per enemy so slow fights don't dominate run time.
      const estDmg = Math.max(0.01, mxP.hit * (P.minHit + P.maxHit) / 2 * (1 - mxP.res) - (E.armour ? 0 : 0));
      const estTurns = Math.max(1, E.hp / estDmg);
      const n = Math.max(20, Math.min(sims, Math.ceil(25000 / estTurns)));
      const sim = simulate(cd, P, E, pTable, eTable, mxP, mxE, n, 1234 + enemyId.length * 7, pe.whenHit);
      const one = { E, mxP, mxE, sim, worst: worstTurn(cd, eTable, E, P, mxE.res), w: s.w / tw };
      if (!agg) agg = { ...one, sim: { ...sim }, parts: [one] };
      else {
        agg.parts.push(one);
        for (const k of Object.keys(sim)) agg.sim[k] = k === 'maxTurnSeen' ? Math.max(agg.sim[k], sim[k]) : agg.sim[k];
        agg.worst = Math.max(agg.worst, one.worst);
      }
    }
    if (agg.parts.length > 1) for (const k of ['killMs', 'takenPerKill', 'pTurnsPerKill', 'eTurnsPerKill', 'dmgPerKill']) agg.sim[k] = agg.parts.reduce((s, x) => s + x.sim[k] * x.w, 0);
    const res = { e, P, ...agg, specials: e.attacks.length, passives: e.passives.length, skipped: pm.skipped + em.skipped };
    cache.set(key, res);
    return res;
  };

  // Combat XP: per point of attack damage (lifesteal healing makes this exceed enemy HP), plus a kill
  // bonus of perDamage x (4 x armour + 50 x ward) (CombatExperienceComponent).
  const perKill = f => {
    const dmg = f.sim.dmgPerKill || f.E.hp;
    const bonus = 4 * (f.e.stats.Armour || 0) + 50 * (f.e.stats.MaximumWard || 0);
    const xp = {};
    for (const x of stanceXp) xp[x.skill] = (xp[x.skill] || 0) + x.perDmg * (dmg + bonus) * xpMult(x.skill);
    return xp;
  };

  const rows = [];
  for (const area of cd.areas) {
    if (area.dungeon) continue;
    const master = masterByArea.get(area.id);
    for (const eid of area.enemies) {
      const f = fight(area, eid);
      if (!f || f.e.demoLocked) continue;
      const cycle = f.sim.killMs + SPAWN_MS;
      const kph = f.sim.stuck ? 0 : 3600000 / cycle;
      const xp = perKill(f);
      const hpBase = (f.e.levels.Hitpoints || 1) * 10;
      const slayer = master ? {
        master: master.name, xp: (hpBase / 8 + 4) * xpMult('Slayer') * kph,
        coins: Math.max(1, Math.floor(0.1 * hpBase ** 1.15 * (1 + slayerCoinPct) + slayerCoinFlat)) * kph,
      } : null;
      const drop = f.e.drops;
      const gpKill = drop.gold + drop.itemValue;
      const takenHr = f.sim.takenPerKill * kph;
      const pTurnsHr = f.sim.pTurnsPerKill * kph;
      rows.push({
        kind: 'enemy', id: `${area.id}:${eid}`, enemy: eid, name: f.e.name, area: area.name, areaId: area.id, category: area.category,
        darkness: area.darkness, cmbLevels: f.e.levels, hp: f.E.hp,
        hitChance: f.mxP.hit, enemyHitChance: f.parts.reduce((s, x) => s + x.mxE.hit * x.w, 0),
        maxHit: f.P.maxHit, minHit: f.P.minHit, playerInterval: f.P.interval, enemyMaxHit: f.parts[0].E.maxHit, enemyInterval: f.parts[0].E.interval,
        enemyRes: f.mxP.res, playerRes: f.parts[0].mxE.res, worstTurn: f.worst, playerHp: f.P.hp, darknessPenalty: f.P.darkness,
        killSeconds: f.sim.killMs / 1000, killsPerHour: kph,
        gpPerKill: gpKill, gpPerHour: gpKill * kph, goldPerHour: drop.gold * kph,
        xpPerHour: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, v * kph])),
        combatXpPerHour: Object.values(xp).reduce((s, v) => s + v, 0) * kph,
        slayer, takenPerHour: takenHr, foodPerHour: foodHeal ? takenHr / foodHeal : null,
        prayerPerHour: prayerCost * pTurnsHr,
        ammoPerHour: ps.ammo ? pTurnsHr * (1 - Math.min(1, ammoPres)) : 0,
        runesPerHour: runeCost.map(rc => ({ id: rc.id, name: cd.name(rc.id), qty: rc.qty * pTurnsHr * (1 - Math.min(1, runePres)) })),
        drops: drop.items.map(d => ({ ...d, perHour: d.qty * d.chance * kph })).sort((a, b) => b.perHour * b.value - a.perHour * a.value),
        specials: f.specials, passives: f.passives, unmodelled: f.skipped,
        ...reqState(area.requirements), stuck: !!f.sim.stuck,
      });
      const row = rows[rows.length - 1];
      row.costPerHour = costOf(row.foodPerHour, row.ammoPerHour, row.runesPerHour);
    }
  }

  for (const d of cd.areas.filter(a => a.dungeon)) {
    let ms = 0, xp = {}, taken = 0, worst = 0, pTurns = 0, n = 0, minHitCh = 1, slow = null;
    let ok = true;
    for (const w of d.waves) {
      const tw = w.enemies.reduce((s, x) => s + x.w, 0) || 1;
      for (const x of w.enemies) {
        const f = fight(d, x.id);
        if (!f) { ok = false; continue; }
        const share = w.count * x.w / tw;
        ms += share * (f.sim.killMs + SPAWN_MS);
        taken += share * f.sim.takenPerKill;
        pTurns += share * f.sim.pTurnsPerKill;
        worst = Math.max(worst, f.worst);
        minHitCh = Math.min(minHitCh, f.mxP.hit);
        if (!slow || f.sim.killMs > slow.ms) slow = { name: f.e.name, ms: f.sim.killMs };
        for (const [k, v] of Object.entries(perKill(f))) xp[k] = (xp[k] || 0) + v * share;
        n += w.count;
      }
    }
    if (!ok || !ms) continue;
    const rph = 3600000 / ms;
    const rw = d.rewards;
    const gpRun = rw.gold + rw.itemValue;
    rows.push({
      kind: 'dungeon', id: d.id, name: d.name, area: 'Dungeon', areaId: d.id, category: d.category, darkness: d.darkness,
      enemiesPerRun: n, runSeconds: ms / 1000, runsPerHour: rph, killSeconds: ms / 1000, killsPerHour: rph,
      hitChance: minHitCh, worstTurn: worst, slowest: slow && { name: slow.name, seconds: slow.ms / 1000 },
      gpPerKill: gpRun, gpPerHour: gpRun * rph, goldPerHour: rw.gold * rph,
      xpPerHour: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, v * rph])),
      combatXpPerHour: Object.values(xp).reduce((s, v) => s + v, 0) * rph,
      takenPerHour: taken * rph, foodPerHour: foodHeal ? taken * rph / foodHeal : null,
      prayerPerHour: prayerCost * pTurns * rph,
      ammoPerHour: ps.ammo ? pTurns * rph * (1 - Math.min(1, ammoPres)) : 0,
      runesPerHour: runeCost.map(rc => ({ id: rc.id, name: cd.name(rc.id), qty: rc.qty * pTurns * rph * (1 - Math.min(1, runePres)) })),
      drops: rw.items.map(i => ({ ...i, perHour: i.qty * i.chance * rph })),
      ...reqState(d.requirements), playerHp: null,
    });
    const row = rows[rows.length - 1];
    row.costPerHour = costOf(row.foodPerHour, row.ammoPerHour, row.runesPerHour);
  }

  const P0 = deriveStats(cd, 'player', { levels: ps.levels, baseStats: ps.baseStats, power: ps.power, protection: ps.protection, stance: ps.stance, element: ps.element, mods: ps.mods, owner: 'Player' });
  return {
    player: {
      loadout: ps.loadout.id, loadoutName: ps.loadout.name, loadouts: Object.values(save.combat.loadouts).map(l => ({ id: l.id, name: l.name, active: l.active })),
      stance: ps.stance, style: ps.style, element: ps.element, spell: ps.spell, prayers: ps.prayers,
      food: ps.food && { id: ps.food, name: cd.name(ps.food), heal: foodHeal },
      equipped: ps.equipped, ammo: ps.ammo && cd.name(ps.ammo), ammoId: ps.ammo,
      accuracy: P0.accuracy, maxHit: P0.maxHit, minHit: P0.minHit, interval: P0.interval, hp: P0.hp, armour: P0.armour,
      protection: P0.protection.Normal, power: P0.power.Normal, levels: P0.levels,
      evasion: { melee: P0.evasion.Stab, ranged: P0.evasion.Accurate, magic: P0.evasion.Offensive },
      mastery: ps.mastery, unmodelled: ps.mods.skipped, notes: ps.notes, slayerLevel,
    },
    rows,
  };
}

if (typeof module !== 'undefined') module.exports = { buildCombatData, evaluateCombat, deriveStats, collect, sum, playerSetup };
else window.Combat = { buildCombatData, evaluateCombat, deriveStats, collect, sum, playerSetup };
