// Skill gear (toolbelt) optimizer.
// Every skill has its own toolbelt: slots like Helmet, Tool, Potion, Utility1/2. Each item fits one slot type and
// may need a level. For an action we try every candidate in every unlocked slot and keep what raises gold/hr
// (or XP/hr) the most, a few passes until nothing changes. Potions are consumed per action, so their sell value
// per action is charged against them.
const { evaluate } = require('./money');
const { checkCondition } = require('./bonuses');

const local = s => (typeof s === 'string' ? s.split(':').pop() : s);

function buildGearData(data) {
  const o = data.Objects;
  const skills = Object.keys(data.EntityConfig).map(local);
  const skillOf = type => skills.filter(s => type.startsWith(s)).sort((a, b) => b.length - a.length)[0] || null;
  const slots = {}; // skill -> [{ id, type, name, req }]
  for (const s of o.ToolbeltSlot || []) {
    const type = local(s.FitsType), skill = skillOf(type);
    if (!skill) continue;
    (slots[skill] ||= []).push({ id: s.Id, type, name: s.DisplayName || s.Id, req: s.UnlockRequirements || [] });
  }
  const byType = {}; // slot type -> [{ id, name, levels:[{skill, level}], consumes, stack }]
  for (const it of o.Item) {
    const t = it.Capabilities?.['MelvorBase:Toolbelt'];
    if (!t?.FitsInSlot) continue;
    const levels = (t.Requirements || []).filter(r => local(r.Type) === 'Level').map(r => ({ skill: local(r.Data?.Component?.Entity), level: r.Data?.Level }));
    (byType[local(t.FitsInSlot)] ||= []).push({
      id: it.Id, name: it.DisplayName?.Singular || it.Id, levels, consumes: (t.ConsumesOn || []).map(c => local(c.Type)), stack: !!t.CanEquipQuantity,
      price: it.SellsFor?.Currency === 'MelvorBase:GoldPieces' ? it.SellsFor.Quantity : 0,
    });
  }
  const slotIds = new Set((o.ToolbeltSlot || []).map(s => s.Id));
  return { slots, byType, slotIds };
}

// Save toolbelt lists alternate slot ids and the item in that slot: [Slot, Item?, Slot, Item?, ...].
function currentSlots(gd, list = []) {
  const out = {};
  let slot = null;
  for (const x of list) {
    if (gd.slotIds.has(x)) { slot = x; continue; }
    if (slot && !out[slot]) out[slot] = x;
  }
  return out;
}

// Slots this account can use for a skill. Unknown conditions count as unlocked.
function openSlots(gd, skill, acct) {
  return (gd.slots[skill] || []).filter(s => s.req.every(r => (acct ? checkCondition(r, acct.ctx) : null) !== false));
}

// Score one action with a given set of items in a skill's toolbelt.
function scoreWith(catalog, opts, a, items, objective) {
  const r = evaluate({ ...catalog, actions: [a] }, { ...opts, toolbelts: { ...opts.toolbelts, [a.skill]: items.map(x => x.id) }, useGear: true })[0];
  if (!r) return { score: -Infinity, r: null };
  const perHour = r.seconds > 0 ? 3600 / r.seconds : 0;
  const potionCost = items.filter(x => x.stack && x.consumes.length).reduce((s, x) => s + x.price * perHour, 0);
  const gp = r.gpPerHour - potionCost;
  return { score: objective === 'xp' ? r.xpPerHour : gp, gp, xp: r.xpPerHour, potionCost, total: gp * r.runHours, r };
}

// Best toolbelt for one action. mode: 'owned' (bank or any toolbelt) or 'all'.
function bestGear(catalog, gd, opts, a, { mode = 'owned', objective = 'gold' } = {}) {
  const { levels = {}, bank = {}, toolbelts = {}, acct } = opts;
  const owned = id => (bank[id] ?? 0) > 0 || Object.values(toolbelts).some(l => l.includes(id));
  const slots = openSlots(gd, a.skill, acct);
  const now = currentSlots(gd, toolbelts[a.skill]);
  const cands = slot => (gd.byType[slot.type] || []).filter(x => (mode === 'all' || owned(x.id)) && x.levels.every(q => (levels[q.skill] ?? 1) >= q.level));
  // Start from what's equipped now (restricted to candidates), then improve slot by slot.
  const pick = {};
  for (const s of slots) { const c = cands(s).find(x => x.id === now[s.id]); if (c) pick[s.id] = c; }
  const set = () => Object.values(pick);
  let best = scoreWith(catalog, opts, a, set(), objective);
  const all = Object.values(gd.byType).flat();
  const base = scoreWith(catalog, opts, a, Object.values(now).map(id => all.find(x => x.id === id) || { id, stack: false, consumes: [], price: 0 }), objective);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const s of slots) {
      const taken = new Set(Object.entries(pick).filter(([k]) => k !== s.id).map(([, v]) => v.id));
      for (const c of [null, ...cands(s)]) {
        if (c && taken.has(c.id)) continue;
        if ((pick[s.id]?.id ?? null) === (c?.id ?? null)) continue;
        const prev = pick[s.id];
        if (c) pick[s.id] = c; else delete pick[s.id];
        const sc = scoreWith(catalog, opts, a, set(), objective);
        if (sc.score > best.score + 1e-6) { best = sc; changed = true; }
        else if (prev) pick[s.id] = prev; else delete pick[s.id];
      }
    }
    if (!changed) break;
  }
  return {
    action: a.id, skill: a.skill, mode, objective,
    slots: slots.map(s => ({ slot: s.id, slotName: s.name, item: pick[s.id]?.id || null, itemName: pick[s.id]?.name || null, owned: pick[s.id] ? owned(pick[s.id].id) : null, current: now[s.id] || null, currentName: now[s.id] ? (all.find(x => x.id === now[s.id])?.name || now[s.id]) : null })),
    gp: best.gp, xp: best.xp, total: best.total, potionCost: best.potionCost, baseGp: base.gp, baseXp: base.xp, baseTotal: base.total,
  };
}

module.exports = { buildGearData, currentSlots, openSlots, bestGear };
