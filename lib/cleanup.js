// Bank cleanup: what in the bank is safe to sell, and why. Three groups:
//  spare  - extra copies of gear you only ever wear one of (two for rings)
//  unused - items nothing in the game uses (no recipe, shop cost, upgrade, quest, task, bait or gear slot)
//  outgrown - single pieces of gear that another piece you own beats on every stat
// Each row says what to keep, so it can go straight into a Course queue as "sell down to N" steps.

const bare = s => String(s || '').replace(/^MelvorBase:/, '');

function cleanup(db, save) {
  const R = k => db.records[k];
  const owned = {};
  for (const t of save.bank.tabs) for (const i of t.items) owned[i.id] = (owned[i.id] || 0) + i.count;
  // Worn gear counts as owned for "you have something better".
  const worn = new Set();
  for (const lo of Object.values(save.combat?.loadouts || {})) for (const e of Object.values(lo.equipment || {})) if (e?.item) worn.add(e.item);
  for (const list of Object.values(save.toolbelts || {})) for (const id of list) worn.add(id);

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
  const statMap = r => Object.fromEntries((eqOf(r)?.Stats?.Stats || []).map(s => [bare(s.Stat), s.Value]));
  const ratings = r => Object.fromEntries([...(eqOf(r)?.Stats?.PowerRatings || []).map(s => ['P' + bare(s.DamageType), s.Value]), ...(eqOf(r)?.Stats?.ProtectionRatings || []).map(s => ['D' + bare(s.DamageType), s.Value])]);
  const hasBonuses = r => { const b = eqOf(r)?.Bonuses || toolOf(r)?.Bonuses; return !!(b && ((b.Component || []).length || (b.Global || []).length)); };
  const kindKey = r => { const e = eqOf(r), w = r.d.Capabilities?.['MelvorBase:Weapon']; return bare(e.Type) + '|' + (w ? bare(w.Type) + bare(w.RequiredAmmoType || '') + bare(w.DamageType || '') + (w.Elements || []).map(bare).sort().join('') : ''); };
  // b beats a: at least as good on every stat and rating, better on one (attack interval: lower is better).
  function beats(b, a) {
    const sa = { ...statMap(a), ...ratings(a) }, sb = { ...statMap(b), ...ratings(b) };
    let better = false;
    for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const x = sa[k] || 0, y = sb[k] || 0;
      const good = k === 'AttackInterval' ? (x === 0 ? 0 : x - y) : y - x;   // positive: b is better here
      if (good < 0) return false;
      if (good > 0) better = true;
    }
    return better;
  }

  const rows = [];
  const allGear = [...new Set([...Object.keys(owned), ...worn])].map(id => R('Item:' + id)).filter(r => r && eqOf(r) && !eqOf(r).CanEquipQuantity);
  for (const [id, count] of Object.entries(owned)) {
    const r = R('Item:' + id);
    if (!r) continue;
    const caps = r.d.Capabilities || {};
    const eq = eqOf(r), tool = toolOf(r);
    const users = usedBy(id);
    const row = (group, keep, why) => rows.push({ id, name: r.n, group, count, keep, sell: count - keep, price: price(r), value: (count - keep) * price(r), why });
    if (eq || tool) {
      const stackable = (eq || tool).CanEquipQuantity;
      if (stackable) continue;                                   // ammo, lanterns, potions: used up
      if (users.length) continue;                                // also an ingredient or upgrade material
      const keep = /Ring/.test(bare(eq?.Type)) ? 2 : 1;
      if (count > keep) { row('spare', keep, `you can only wear ${keep === 1 ? 'one' : 'two'}`); continue; }
      if (eq && !hasBonuses(r) && !sets.has(id)) {
        const better = allGear.find(b => b !== r && kindKey(b) === kindKey(r) && !hasBonuses(b) && beats(b, r));
        if (better) row('outgrown', 0, `${better.n} is better on every stat`);
      }
      continue;
    }
    if (users.length) continue;
    if (Object.keys(caps).length) continue;
    if ((db.itemRel?.[id]?.sources || []).some(e => e.from.startsWith('HerbloreRecipe:'))) continue;   // potions work through the game's code (ranching illness and so on)                      // food, openables, bait and the like do something
    if (!price(r)) continue;
    row('unused', 0, 'nothing in the game uses it');
  }
  const order = { spare: 0, outgrown: 1, unused: 2 };
  rows.sort((a, b) => order[a.group] - order[b.group] || b.value - a.value);
  return { rows, total: rows.reduce((s, r) => s + r.value, 0) };
}

module.exports = { cleanup };
