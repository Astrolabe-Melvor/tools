// Astrology: constellations, node slots, what nodes and observations unlock, and node rankings.
// Knowledge is per constellation and only goes up; minor slots open at fixed knowledge totals and you choose
// which minor node fills each slot. Every 4 minor nodes opens a major slot. Majors can be picked in any order.
const { evaluate } = require('./money');
const { checkCondition } = require('./bonuses');
const local = s => (typeof s === 'string' ? s.split(':').pop() : s);
const dn = n => typeof n === 'string' ? n : n?.Singular || n?.Plural || '';

function buildAstroData(data) {
  const o = data.Objects;
  const byId = (t) => new Map((o[t] || []).map(x => [x.Id, x]));
  const nodes = byId('AstrologyNode'), tables = byId('AstrologyTableEvent'), obs = byId('AstrologyObservationEvent');
  const lvlReq = (reqs, skill) => (reqs || []).filter(q => local(q.Type) === 'Level' && (!skill || local(q.Data?.Component?.Entity) === skill)).map(q => ({ skill: local(q.Data.Component.Entity), level: q.Data.Level, or: !!q.Data.IsOr }));
  const cons = (o.AstrologyConstellation || []).map(c => ({
    id: c.Id, name: dn(c.DisplayName) || c.Id, level: lvlReq(c.Requirements, 'Astrology')[0]?.level ?? 1,
    secondary: lvlReq(c.SecondaryRequirements), xp: c.BaseExperience, interval: c.BaseInterval, knowledge: c.BaseKnowledge ?? 1,
    thresholds: c.MinorNodeUnlockKnowledge || [], perMajor: c.MinorNodesPerMajorNode || 4, entities: (c.Entities || []).map(local),
    perMinor: c.PerMinorNodeBonuses || null,
    minors: (c.MinorNodes || []).map(local).map(id => ({ id, name: nodes.get(id)?.DisplayName || id, bonuses: nodes.get(id)?.Bonuses, req: lvlReq(nodes.get(id)?.UnlockRequirements), desc: nodes.get(id)?.Description || null })),
    majors: (c.MajorNodes || []).map(local).map(id => ({ id, name: nodes.get(id)?.DisplayName || id, bonuses: nodes.get(id)?.Bonuses, req: lvlReq(nodes.get(id)?.UnlockRequirements), desc: nodes.get(id)?.Description || null })),
    observations: [],
  }));
  // Observation chances: the constellation's table rolls each study, then a weighted pick.
  const obsChance = {};
  for (const c of cons) {
    const raw = (o.AstrologyConstellation.find(x => x.Id === c.id).Events || []).map(local);
    for (const tid of raw) {
      const t = tables.get(tid);
      if (!t) continue;
      const total = (t.Events || []).reduce((s, e) => s + e.Weight, 0) || 1;
      for (const e of t.Events || []) {
        const id = local(e.Event), p = (t.Chance ?? 0) * e.Weight / total;
        obsChance[id] = (obsChance[id] || 0) + p;
        if (!/^Nothing/.test(id)) c.observations.push({ id, chance: p, text: obs.get(id)?.Observation || '', unlockText: obs.get(id)?.UnlockText || null });
      }
    }
  }
  // What major nodes and observations unlock elsewhere in the game.
  const gates = {}, obsGates = {};
  const walk = (v, owner) => {
    if (Array.isArray(v)) { v.forEach(x => walk(x, owner)); return; }
    if (!v || typeof v !== 'object') return;
    const t = typeof v.Type === 'string' ? local(v.Type) : null;
    if (t === 'AstrologyMajorNodeUnlocked' && v.Data?.MajorNode) (gates[local(v.Data.MajorNode)] ||= new Set()).add(owner);
    if (t === 'AstrologyEventStatistic' && v.Data?.Event) (obsGates[local(v.Data.Event)] ||= new Set()).add(owner);
    for (const x of Object.values(v)) walk(x, owner);
  };
  for (const [t, list] of Object.entries(o)) if (Array.isArray(list)) for (const r of list) if (r && r.Id) walk(r, `${t}:${r.Id}`);
  const fix = m => Object.fromEntries(Object.entries(m).map(([k, s]) => [k, [...s]]));
  return { cons, gates: fix(gates), obsGates: fix(obsGates), obsChance };
}

// Knowledge needed for the n-th minor slot (1-based) and hours to get there at a given knowledge per hour,
// counting the +x% knowledge each unlocked minor node adds.
function slotHours(con, have, upTo, kph, perMinorPct = 0.02, minorsNow = 0) {
  let h = 0, k = have;
  for (let i = minorsNow; i < upTo && i < con.thresholds.length; i++) {
    const need = con.thresholds[i] - k;
    if (need > 0) { h += need / (kph * (1 + perMinorPct * i)); k = con.thresholds[i]; }
  }
  return h;
}

// Personal: rank every node you could pick next by how much it raises your best gold/hr and XP/hr.
// Short plain-text version of a node's bonuses for the tools page.
function describe(n) {
  const b = n.bonuses || {};
  const parts = (b.Component || []).map(m => {
    const v = m.Value, name = m.Stat?.Name || '';
    const pct = /^(Percent|Increased)|Chance|Preservation/.test(name) && Math.abs(v) < 5;
    const ctx = Object.entries(m.LocalContext || {}).filter(([k, x]) => x && typeof x === 'string').map(([, x]) => local(x)).join(' ') || local(m.LocalContext?.Component?.Entity) || '';
    return `${v > 0 ? '+' : ''}${pct ? Math.round(v * 1000) / 10 + '%' : v} ${name.replace(/([a-z])([A-Z])/g, '$1 $2')}${ctx ? ' (' + ctx + ')' : ''}`;
  });
  for (const g of b.Global || []) parts.push(`${g.Value > 0 ? '+' : ''}${Math.round(g.Value * 1000) / 10}% ${String(g.StatGroup).replace(/([a-z])([A-Z])/g, '$1 $2')}`);
  if ((b.CombatEffect || []).length) parts.push('combat effect');
  if (n.desc) parts.push(String(n.desc).replace(/\[[^\]]*\]/g, ''));
  return parts.join('; ');
}

function astroPlan(catalog, ad, { levels, bank, toolbelts, acct, journal, save }) {
  const st = save.astrology || {};
  const HOURS = 8;
  const bests = res => { const out = {}; for (const r of res) { if (!r.unlocked || r.notes?.includes('quest only')) continue; const b = out[r.skill] ||= { gp: -Infinity, xp: 0 }; b.gp = Math.max(b.gp, (r.totalForHours ?? r.gpPerHour * HOURS) / HOURS); b.xp = Math.max(b.xp, r.xpPerHour); } return out; };
  const supported = new Set(catalog.actions.map(a => a.skill));
  const cache = new Map();
  const run = (skills, a) => bests(evaluate({ ...catalog, actions: catalog.actions.filter(x => skills.has(x.skill)) }, { levels, bank, toolbelts, acct: a, journal, hours: HOURS }));
  const base = skills => { const k = [...skills].sort().join(); if (!cache.has(k)) cache.set(k, run(skills, acct)); return cache.get(k); };
  const value = (bonuses, src) => {
    if (!bonuses) return { rows: [], gp: 0, xpPct: 0, combat: false };
    const comp = bonuses.Component || [], glob = bonuses.Global || [];
    let skills = new Set(comp.map(m => local(m.LocalContext?.Component?.Entity)).filter(s => supported.has(s)));
    if (glob.length) skills = new Set(supported);
    const combat = comp.some(m => /Character|Combat|Player/.test(m.Stat?.StatsType || '')) || (bonuses.CombatEffect || []).length > 0;
    if (!skills.size) return { rows: [], gp: 0, xpPct: 0, combat };
    const a2 = { ...acct, entries: [...acct.entries, ...comp.map(m => ({ m, src, mult: 1 })), ...glob.map(g => ({ global: g.StatGroup, value: g.Value, src }))] };
    const before = base(skills), after = run(skills, a2);
    const rows = [...skills].map(s => ({ skill: s, gpGain: (after[s]?.gp ?? 0) - (before[s]?.gp ?? 0), xpPct: before[s]?.xp > 0 ? (after[s].xp - before[s].xp) / before[s].xp : 0 }));
    return { rows, gp: rows.reduce((v, r) => v + Math.max(0, r.gpGain), 0), xpPct: Math.max(0, ...rows.map(r => r.xpPct)), combat };
  };
  const astroLv = levels.Astrology ?? 1;
  const ctx = acct.ctx;
  const met = req => req.every(q => (levels[q.skill] ?? 1) >= q.level);
  // Knowledge per hour: 3 s base interval, astrology interval and knowledge bonuses from the account.
  const out = [];
  for (const c of ad.cons) {
    const s = st[c.id] || { knowledge: 0, minor: [], major: [] };
    const minorsNow = s.minor.length, majorsNow = s.major.length;
    const unlocked = astroLv >= c.level && (c.secondary.length === 0 || c.secondary.some(q => (levels[q.skill] ?? 1) >= q.level));
    const kph = 3600000 / c.interval * c.knowledge * (1 + 0.02 * minorsNow);
    const slotsEarned = c.thresholds.filter(t => s.knowledge >= t).length;
    const freeMinor = Math.max(0, slotsEarned - minorsNow), freeMajor = Math.max(0, Math.floor(minorsNow / c.perMajor) - majorsNow);
    const nextAt = c.thresholds[slotsEarned] ?? null;
    const cand = [];
    for (const n of c.minors) if (!s.minor.includes(n.id)) cand.push({ ...n, kind: 'minor', available: met(n.req), value: value(n.bonuses, 'astrology: ' + n.id) });
    for (const n of c.majors) if (!s.major.includes(n.id)) cand.push({ ...n, kind: 'major', available: met(n.req), unlocks: ad.gates[n.id] || [], value: value(n.bonuses, 'astrology: ' + n.id) });
    const score = n => (n.unlocks?.length ? 1e12 : 0) + n.value.gp + n.value.xpPct * 1e5 + (n.value.combat ? 1 : 0);
    cand.sort((a, b) => (b.available - a.available) || score(b) - score(a));
    out.push({
      id: c.id, name: c.name, level: c.level, unlocked, knowledge: s.knowledge, minors: minorsNow, majors: majorsNow, freeMinor, freeMajor,
      nextAt, hoursToNext: nextAt ? Math.max(0, nextAt - s.knowledge) / kph : null, kph, xph: 3600000 / c.interval * c.xp,
      candidates: cand.map(n => ({ id: n.id, name: n.name, kind: n.kind, text: describe(n), available: n.available, req: n.req, unlocks: n.unlocks || [], gp: n.value.gp, xpPct: n.value.xpPct, combat: n.value.combat, rows: n.value.rows.filter(r => r.gpGain > 0.5 || r.xpPct > 0.0001) })),
    });
  }
  return out;
}

module.exports = { buildAstroData, slotHours, astroPlan };
