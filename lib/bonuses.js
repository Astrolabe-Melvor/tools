// Account-wide bonuses read from the save: shop purchases, unlocked pets, mastery guild rank bonuses
// and astrology nodes. Returned as raw game modifier entries (with LocalContext) so the money and
// combat calculators can filter them the same way they filter gear.
const local = id => (id || '').replace(/^MelvorBase:/, '');

function buildBonusData(data) {
  const o = data.Objects;
  const map = type => new Map((o[type] || []).map(r => [local(r.Id), r]));
  const cats = new Map((o.MasteryGuildCategory || []).map(c => [local(c.Id), c.BasePoints]));
  const taskDefs = map('MasteryGuildTask');
  const taskPoints = new Map([...taskDefs].map(([k, t]) => [k, cats.get(local(t.Category)) || 0]));
  const rankDefs = map('MasteryGuildRank');
  const bonusDefs = map('MasteryGuildBonus');
  const mastery = {};
  for (const [ent, cfg] of Object.entries(data.EntityConfig)) {
    if (!cfg.MasteryGuildTasks) continue;
    const sk = local(ent);
    const ids = cfg.MasteryGuildTasks.map(x => local(x.Id));
    const ranks = (cfg.MasteryGuildRanks || []).map(x => rankDefs.get(local(x.Id))).filter(Boolean)
      .map(r => ({ id: local(r.Id), name: r.DisplayName, frac: r.PointPercentRequired })).sort((a, b) => a.frac - b.frac);
    const bonuses = (cfg.MasteryGuildBonuses || []).map(x => bonusDefs.get(local(x.Id))).filter(Boolean)
      .map(b => ({ id: local(b.Id), rank: local(b.Requirements?.find(q => /MasteryGuildRank/.test(q.Type))?.Data?.Rank), bonuses: b.Rewards?.Bonuses }));
    mastery[sk] = { tasks: ids, total: ids.reduce((s, t) => s + (taskPoints.get(t) || 0), 0), ranks, bonuses };
  }
  return {
    mastery, taskDefs, taskPoints, shop: map('ShopPurchase'), pets: map('Pet'), nodes: map('AstrologyNode'),
    constellations: map('AstrologyConstellation'), techniques: map('AgilityTechnique'),
  };
}

// Agility technique XP curve (AgilityTechniqueExperienceTable).
const techXp = L => L < 1 ? 0 : Math.floor((L * L - L + 600 * (2 ** (L / 3.25) - 2 ** (1 / 3.25)) / (2 ** (1 / 3.25) - 1)) / 6);
function techLevel(xp, cap = 40) { let L = 1; while (L < cap && xp >= techXp(L + 1)) L++; return L; }

const STAT_KEYS = ['Item', 'Master', 'Course', 'Animal', 'Event', 'Dungeon', 'Enemy', 'Currency', 'Species', 'Constellation', 'Area', 'Recipe'];

// true / false, or null when the save doesn't tell us (treated as not met by callers).
function checkCondition(c, ctx) {
  const t = local(c.Type), d = c.Data || {};
  switch (t) {
    case 'Level': return (ctx.levels[local(d.Component?.Entity)] || 1) >= d.Level;
    case 'PetUnlocked': return ctx.pets.includes(local(d.Pet));
    case 'ShopPurchase': return (ctx.shop[local(d.ShopPurchase)] || 0) >= (d.Amount || 1);
    case 'AgilityTechniqueLevel': return (ctx.techLevels[local(d.Technique)] || 1) >= d.Level;
    case 'AgilityNumTechniquesLevel': return Object.values(ctx.techLevels).filter(l => l >= d.Level).length >= d.NumTechniques;
    case 'AstrologyMinorNodeUnlockCount': return (ctx.astrology[local(d.Constellation)]?.minor.length || 0) >= d.Count;
    case 'AstrologyMajorNodeUnlockCount': return (ctx.astrology[local(d.Constellation)]?.major.length || 0) >= d.Count;
    case 'MasteryGuildRank': {
      const sk = local(d.Component?.Entity);
      const r = ctx.ranks?.[sk];
      if (!r) return null;
      const need = ctx.bd.mastery[sk]?.ranks.findIndex(x => x.id === local(d.Rank));
      return need >= 0 ? r.index >= need : null;
    }
  }
  if (d.Statistic) {
    const v = ctx.stats[local(d.Statistic)];
    if (v == null) return d.Value <= 0;
    if (typeof v === 'number') return v >= d.Value;
    const k = STAT_KEYS.find(x => d[x]);
    return k ? (v[local(d[k])] || 0) >= d.Value : Object.values(v).reduce((s, x) => s + x, 0) >= d.Value;
  }
  return null;
}

function evalGroup(list, ctx) {
  // Consecutive IsOr entries form an OR group; groups are ANDed.
  const groups = [];
  for (const c of list || []) { if (c.Data?.IsOr && groups.length) groups[groups.length - 1].push(c); else groups.push([c]); }
  let unknown = false;
  for (const g of groups) {
    const r = g.map(c => checkCondition(c, ctx));
    if (r.some(x => x === true)) continue;
    if (r.some(x => x === null)) { unknown = true; continue; }
    return false;
  }
  return unknown ? null : true;
}

function masteryState(bd, save, ctx) {
  const ranks = {};
  for (const [sk, m] of Object.entries(bd.mastery)) {
    const raw = save.mastery?.[sk] || {};
    let pts = 0, done = 0, unknownPts = 0;
    for (const tid of m.tasks) {
      const def = bd.taskDefs.get(tid), st = raw[tid];
      if (!def || !st) continue;
      if (def.Goal && !st.goal) continue;
      if (def.TriggerGoal && !st.trigger) continue;
      let ok = true;
      if (def.ConditionGoal) ok = checkCondition(def.ConditionGoal, ctx);
      if (ok === true) { pts += bd.taskPoints.get(tid) || 0; done++; }
      else if (ok === null) unknownPts += bd.taskPoints.get(tid) || 0;
    }
    let idx = 0;
    m.ranks.forEach((r, i) => { if (pts >= Math.ceil(m.total * r.frac)) idx = i; });
    ranks[sk] = { points: pts, total: m.total, done, index: idx, rank: m.ranks[idx]?.id, rankName: m.ranks[idx]?.name, uncheckedPoints: unknownPts };
  }
  return ranks;
}

function accountBonuses(bd, save) {
  const levels = Object.fromEntries((save.skills || []).map(s => [s.id, s.level]));
  const techLevels = Object.fromEntries(Object.entries(save.techniques || {}).map(([k, xp]) => [k, techLevel(xp, bd.techniques.get(k)?.LevelCap || 40)]));
  const ctx = { bd, levels, pets: save.pets || [], stats: save.statistics || {}, astrology: save.astrology || {}, techLevels, shop: save.shop || {} };
  ctx.ranks = masteryState(bd, save, ctx);
  const entries = [];
  const add = (bonuses, src, mult = 1) => {
    if (!bonuses) return;
    for (const m of bonuses.Component || []) entries.push({ m, src, mult });
    for (const g of bonuses.Global || []) entries.push({ global: g.StatGroup, value: g.Value * mult, src });
  };
  const shop = [];
  for (const [id, q] of Object.entries(save.shop || {})) {
    const p = bd.shop.get(id);
    const b = p?.Provides?.Bonuses;
    if (!b || !((b.Component || []).length || (b.Global || []).length)) continue;
    const mult = q; // ShopComponent adds each purchase's bonuses with multiplier = quantity bought
    add(b, 'shop: ' + (p.DisplayName || id), mult);
    shop.push(p.DisplayName || id);
  }
  for (const id of save.pets || []) add(bd.pets.get(id)?.Bonuses, 'pet: ' + id);
  for (const [sk, m] of Object.entries(bd.mastery)) {
    const r = ctx.ranks[sk];
    for (const b of m.bonuses) {
      const need = m.ranks.findIndex(x => x.id === b.rank);
      if (need >= 0 && r.index >= need) add(b.bonuses, `${sk} mastery`);
    }
  }
  for (const [cid, st] of Object.entries(save.astrology || {})) {
    for (const n of [...st.minor, ...st.major]) add(bd.nodes.get(n)?.Bonuses, 'astrology: ' + n);
    const con = bd.constellations.get(cid);
    if (con?.PerMinorNodeBonuses && st.minor.length) add(con.PerMinorNodeBonuses, 'astrology: ' + cid, st.minor.length);
  }
  return { entries, ranks: ctx.ranks, techLevels, shop, ctx };
}

module.exports = { buildBonusData, accountBonuses, checkCondition, evalGroup, techLevel };
