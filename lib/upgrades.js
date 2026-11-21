// Upgrade suggestions: for each shop purchase you don't own yet and each skill's next mastery rank,
// re-run the money model with that bonus added and report how much it raises the best gold/hr and
// best XP/hr in the skills it affects, against what it costs.
const local = id => (id || '').replace(/^MelvorBase:/, '');
const { evaluate, evaluatePassive } = require('./money');
const { evalGroup } = require('./bonuses');
const GOLD = 'MelvorBase:GoldPieces';

const dn = n => typeof n === 'string' ? n : n?.Singular || n?.Plural || '';

// Best rates per skill from a money result list (unlocked, not quest-only). Gold uses the 8-hour
// total (stock-limited methods don't count beyond what your bank can feed), expressed per hour.
const HOURS = 8;
function bests(results) {
  const out = {};
  for (const r of results) {
    if (!r.unlocked || r.notes?.includes('quest only') || !isFinite(r.gpPerHour)) continue;
    const b = out[r.skill] ||= { gp: -Infinity, gpName: '', xp: 0, xpName: '' };
    const g = (r.totalForHours ?? r.gpPerHour * HOURS) / HOURS;
    if (g > b.gp) { b.gp = g; b.gpName = r.name; }
    if (r.xpPerHour > b.xp) { b.xp = r.xpPerHour; b.xpName = r.name; }
  }
  return out;
}

function upgrades(catalog, bd, { levels, bank, toolbelts, acct, journal, farming, ranching, wallet = {} }) {
  const skillsOf = bonuses => new Set((bonuses?.Component || []).map(m => local(m.LocalContext?.Component?.Entity)).filter(Boolean));
  const run = (skills, a) => {
    const sub = { ...catalog, actions: catalog.actions.filter(x => skills.has(x.skill)) };
    let res = evaluate(sub, { levels, bank, toolbelts, acct: a, journal, hours: HOURS });
    if (skills.has('Farming') || skills.has('Ranching')) res = res.concat(evaluatePassive(catalog, { levels, bank, toolbelts, acct: a, farming, ranching, hours: HOURS }));
    return bests(res);
  };
  const withExtra = (bonuses, src) => ({ ...acct, entries: [...acct.entries, ...(bonuses.Component || []).map(m => ({ m, src, mult: 1 })), ...(bonuses.Global || []).map(g => ({ global: g.StatGroup, value: g.Value, src }))] });
  const cache = new Map();
  const base = skills => { const k = [...skills].sort().join(','); if (!cache.has(k)) cache.set(k, run(skills, acct)); return cache.get(k); };

  const delta = (bonuses, src) => {
    const skills = skillsOf(bonuses);
    const supported = new Set(catalog.actions.map(a => a.skill).concat(['Farming', 'Ranching']));
    const sk = new Set([...skills].filter(s => supported.has(s)));
    if (!sk.size) return { skills: [...skills], rows: [] };
    const before = base(sk), after = run(sk, withExtra(bonuses, src));
    const rows = [...sk].map(s => ({
      skill: s,
      gpBefore: before[s]?.gp ?? 0, gpAfter: after[s]?.gp ?? 0, gpMethod: after[s]?.gpName,
      xpBefore: before[s]?.xp ?? 0, xpAfter: after[s]?.xp ?? 0, xpMethod: after[s]?.xpName,
    })).map(r => ({ ...r, gpGain: r.gpAfter - r.gpBefore, xpGain: r.xpAfter - r.xpBefore, xpPct: r.xpBefore > 0 ? (r.xpAfter - r.xpBefore) / r.xpBefore : 0 }));
    return { skills: [...skills], rows };
  };

  const describe = bonuses => (bonuses?.Component || []).map(m => {
    const v = m.Value, n = m.Stat?.Name || '';
    const pct = /^(Percent|Increased)|Chance$|Preservation/.test(n);
    const ctx = Object.entries(m.LocalContext || {}).filter(([k, x]) => x && k !== 'Component' && typeof x === 'string').map(([, x]) => local(x)).join(', ');
    return `${v > 0 ? '+' : ''}${pct ? Math.round(v * 1000) / 10 + '%' : v} ${n.replace(/([a-z])([A-Z])/g, '$1 $2')}${ctx ? ' (' + ctx + ')' : ''}`;
  });

  const price = id => catalog.items[id]?.price ?? 0;
  const shop = [];
  for (const [id, p] of bd.shop) {
    const b = p.Provides?.Bonuses;
    if (!b || !(b.Component || []).length) continue;
    const have = acct.ctx.shop[id] || 0;
    if (p.DefaultBuyLimit > 0 && have >= p.DefaultBuyLimit) continue;
    const req = evalGroup(p.Requirements || [], acct.ctx);
    if (req === false) {
      // Only show locked purchases whose sole blocker is a not-yet-owned earlier tier you could buy now.
      continue;
    }
    const gold = (p.Costs?.Currencies || []).filter(c => c.Currency === GOLD).reduce((v, c) => v + c.Quantity, 0);
    const other = (p.Costs?.Currencies || []).filter(c => c.Currency !== GOLD).map(c => ({ id: local(c.Currency), qty: c.Quantity }));
    const items = (p.Costs?.Items || []).map(x => ({ id: local(x.Item), name: catalog.items[local(x.Item)]?.name || local(x.Item), qty: x.Quantity, have: bank[local(x.Item)] ?? 0 }));
    const itemValue = items.reduce((v, x) => v + x.qty * price(x.id), 0);
    const d = delta(b, 'shop: ' + dn(p.DisplayName));
    const top = d.rows.sort((x, y) => y.gpGain - x.gpGain)[0];
    const xpTop = [...d.rows].sort((x, y) => y.xpPct - x.xpPct)[0];
    const cost = gold + itemValue;
    shop.push({
      kind: 'shop', id, name: dn(p.DisplayName) || id, category: local(p.Subcategory).replace(/([a-z])([A-Z])/g, '$1 $2'),
      effects: describe(b), skills: d.skills, rows: d.rows,
      gpGain: top?.gpGain || 0, gpSkill: top?.skill, gpMethod: top?.gpMethod,
      xpPct: xpTop?.xpPct || 0, xpGain: xpTop?.xpGain || 0, xpSkill: xpTop?.skill, xpMethod: xpTop?.xpMethod,
      gold, other, items, cost, unknownReq: req === null,
      canAfford: gold <= (wallet.GoldPieces || 0) && other.every(c => (wallet[c.id] || 0) >= c.qty) && items.every(x => x.have >= x.qty),
      paybackHours: (top?.gpGain || 0) > 0 ? cost / top.gpGain : null,
      modelled: d.rows.length > 0,
    });
  }

  const mastery = [];
  for (const [sk, m] of Object.entries(bd.mastery)) {
    const r = acct.ranks[sk];
    if (!r || r.index >= m.ranks.length - 1) continue;
    const next = m.ranks[r.index + 1];
    const need = Math.ceil(m.total * next.frac);
    const bon = m.bonuses.filter(b => b.rank === next.id && b.bonuses);
    const merged = { Component: bon.flatMap(b => b.bonuses.Component || []), Global: bon.flatMap(b => b.bonuses.Global || []) };
    const d = merged.Component.length ? delta(merged, `${sk} mastery`) : { skills: [], rows: [] };
    const top = d.rows.sort((x, y) => y.gpGain - x.gpGain)[0];
    let xpTop = [...d.rows].sort((x, y) => y.xpPct - x.xpPct)[0];
    if (!xpTop) {
      // Not simulated here (combat skills): XP bonuses are still a straight percentage on that skill.
      const xp = merged.Component.filter(x => x.Stat?.Name === 'PercentXPGained').reduce((v, x) => v + x.Value, 0);
      if (xp) xpTop = { xpPct: xp, xpGain: 0, skill: sk };
    }
    mastery.push({
      kind: 'mastery', id: sk, name: `${sk}: ${next.name}`, skill: sk, rank: r.rankName, points: r.points, need, toGo: need - r.points,
      effects: describe(merged), rows: d.rows, gpGain: top?.gpGain || 0, gpMethod: top?.gpMethod, xpPct: xpTop?.xpPct || 0, xpGain: xpTop?.xpGain || 0,
      xpSkill: xpTop?.skill, modelled: d.rows.length > 0, noBonus: !merged.Component.length && !merged.Global.length,
    });
  }
  return { shop, mastery };
}

module.exports = { upgrades };
