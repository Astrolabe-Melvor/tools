// Bank cleanup: what in the bank is safe to sell, and why. Three groups:
//  spare  - extra copies of gear you only ever wear one of (two for rings)
//  unused - items nothing in the game uses (no recipe, shop cost, upgrade, quest, task, bait or gear slot)
//  outgrown - single pieces of gear that another piece you own beats on every stat
// Each row says what to keep, so it can go straight into a Course queue as "sell down to N" steps.
//
// Two halves: cleanupFacts(db) is what the game data says about each item (the same for everyone; published as
// cleanup.json for the in-game Hold mod), and cleanupRows(facts, owned, worn) decides from what you own.
//
// cleanup.json: { gameVersion, items: { <local id>: {
//     n: name, p: sell price,
//     g: 1 gear | 2 toolbelt tool (absent: neither),
//     k: how many you can wear (2 for rings, else 1),
//     u: 1 when something uses it (an ingredient, cost or upgrade: never sold),
//     x: 1 when sellable as unused (not gear, nothing uses it, does nothing),
//     c: gear kind ("Weapon|SwordSlash..."; only gear of the same kind is compared),
//     s: { stat: value } stats and ratings, b: 1 when it has bonuses, e: 1 when part of an equipment set } } }
// Only items that can ever be listed (non-stackable gear and tools, unused items) are in it.

const bare = s => String(s || '').replace(/^MelvorBase:/, '');

function cleanupFacts(db) {
  const R = k => db.records[k];
  const sets = new Set();
  for (const r of Object.values(db.records)) if (r.t === 'EquipmentSetBonus') for (const i of r.d.Items || []) sets.add(bare(i));

  const eqOf = r => r?.d?.Capabilities?.['MelvorBase:Equipment'];
  const toolOf = r => r?.d?.Capabilities?.['MelvorBase:Toolbelt'];
  const price = r => r?.d?.SellsFor?.Quantity || 0;
  // Who uses an item: recipe/shop/upgrade inputs and requirements, plus anything else that refers to it
  // except the things that make it (bait for hunting, quest and guild task items, and so on).
  function usedBy(id) {
    const rel = db.itemRel?.[id] || { sources: [], uses: [], requiredBy: [] };
    const makers = new Set(rel.sources.map(e => e.from));
    const users = new Set([...rel.uses, ...rel.requiredBy].map(e => e.from));
    for (const k of R('Item:' + id)?.refBy || []) {
      if (makers.has(k)) continue;
      const t = k.split(':')[0];
      if (/Recipe$|^Enemy$|^Item$|Drop|Chest|Openable|^AstrologyItemEvent$|^EquipmentSetBonus$|^Dungeon$|^CombatArea$/.test(t)) continue;   // things that give it, or point at it in passing
      users.add(k);
    }
    return [...users];
  }
  const stats = r => Object.fromEntries([
    ...(eqOf(r)?.Stats?.Stats || []).map(s => [bare(s.Stat), s.Value]),
    ...(eqOf(r)?.Stats?.PowerRatings || []).map(s => ['P' + bare(s.DamageType), s.Value]),
    ...(eqOf(r)?.Stats?.ProtectionRatings || []).map(s => ['D' + bare(s.DamageType), s.Value])]);
  const hasBonuses = r => { const b = eqOf(r)?.Bonuses || toolOf(r)?.Bonuses; return !!(b && ((b.Component || []).length || (b.Global || []).length)); };
  const kindKey = r => { const e = eqOf(r), w = r.d.Capabilities?.['MelvorBase:Weapon']; return bare(e.Type) + '|' + (w ? bare(w.Type) + bare(w.RequiredAmmoType || '') + bare(w.DamageType || '') + (w.Elements || []).map(bare).sort().join('') : ''); };

  const items = {};
  for (const r of Object.values(db.records)) {
    if (r.t !== 'Item') continue;
    const id = r.id, eq = eqOf(r), tool = toolOf(r);
    const used = usedBy(id).length > 0;
    if (eq || tool) {
      if ((eq || tool).CanEquipQuantity) continue;               // ammo, lanterns, potions: used up
      const f = { n: r.n, p: price(r), g: eq ? 1 : 2, k: /Ring/.test(bare(eq?.Type)) ? 2 : 1 };
      if (used) f.u = 1;
      if (eq) { f.c = kindKey(r); f.s = stats(r); if (hasBonuses(r)) f.b = 1; if (sets.has(id)) f.e = 1; }
      else if (hasBonuses(r)) f.b = 1;
      items[id] = f;
      continue;
    }
    if (used || Object.keys(r.d.Capabilities || {}).length || !price(r)) continue;   // food, openables, bait and the like do something
    if ((db.itemRel?.[id]?.sources || []).some(e => e.from.startsWith('HerbloreRecipe:'))) continue;   // potions work through the game's code (ranching illness and so on)
    items[id] = { n: r.n, p: price(r), x: 1 };
  }
  return { gameVersion: db.gameVersion, items };
}

// b beats a: at least as good on every stat and rating, better on one (attack interval: lower is better).
function beats(b, a) {
  const sa = a.s || {}, sb = b.s || {};
  let better = false;
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    const x = sa[k] || 0, y = sb[k] || 0;
    const good = k === 'AttackInterval' ? (x === 0 ? 0 : x - y) : y - x;   // positive: b is better here
    if (good < 0) return false;
    if (good > 0) better = true;
  }
  return better;
}

// owned: { id: count in the bank }, worn: ids equipped anywhere (they count as "something better you own").
function cleanupRows(facts, owned, worn) {
  const F = facts.items;
  const rows = [];
  const allGear = [...new Set([...Object.keys(owned), ...worn])].filter(id => F[id]?.g === 1);
  for (const [id, count] of Object.entries(owned)) {
    const f = F[id];
    if (!f) continue;
    const row = (group, keep, why) => rows.push({ id, name: f.n, group, count, keep, sell: count - keep, price: f.p, value: (count - keep) * f.p, why });
    if (f.g) {
      if (f.u) continue;                                         // also an ingredient or upgrade material
      if (count > f.k) { row('spare', f.k, `you can only wear ${f.k === 1 ? 'one' : 'two'}`); continue; }
      if (f.g === 1 && !f.b && !f.e) {
        const better = allGear.find(b => b !== id && F[b].c === f.c && !F[b].b && beats(F[b], f));
        if (better) row('outgrown', 0, `${F[better].n} is better on every stat`);
      }
      continue;
    }
    if (f.x) row('unused', 0, 'nothing in the game uses it');
  }
  const order = { spare: 0, outgrown: 1, unused: 2 };
  rows.sort((a, b) => order[a.group] - order[b.group] || b.value - a.value);
  return { rows, total: rows.reduce((s, r) => s + r.value, 0) };
}

const factsCache = new WeakMap();
function cleanup(db, save) {
  if (!factsCache.has(db)) factsCache.set(db, cleanupFacts(db));
  const owned = {};
  for (const t of save.bank.tabs) for (const i of t.items) owned[i.id] = (owned[i.id] || 0) + i.count;
  const worn = new Set();
  for (const lo of Object.values(save.combat?.loadouts || {})) for (const e of Object.values(lo.equipment || {})) if (e?.item) worn.add(e.item);
  for (const list of Object.values(save.toolbelts || {})) for (const id of list) worn.add(id);
  return cleanupRows(factsCache.get(db), owned, worn);
}

module.exports = { cleanup, cleanupFacts, cleanupRows };
