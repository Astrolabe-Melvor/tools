// spyglass.json: the slice of the wiki the in-game Spyglass mod downloads. For each item: its name, where it comes
// from, what uses it, and what it unlocks. Kept small (no descriptions, stats or images) so the game parses it fast.
//
// { gameVersion, items: { <local id>: { n: name,
//     s: [[type, id, name, skill, min, max, chance]],   // sources: chance is 0..1, or null when it always comes
//     u: [[type, id, name, skill, qty]],                // uses (ingredient or cost)
//     r: [[type, id, name, skill]] } } }                // needed to unlock or do these
function buildSpyglass(db) {
  const rec = id => db.records[id] || {};
  const row = (s, withAmounts) => {
    const r = rec(s.from);
    const [type, id] = s.from.split(':');
    const base = [type, id, r.n || id, typeof r.o === 'string' ? r.o : ''];
    return withAmounts ? base.concat([s.min, s.max, s.chance ?? s.share ?? null]) : base;
  };
  // A shop bonus or a requirement that mentions the item is not a way to get it.
  const isSource = s => !/Bonuses|Requirements|Conditions/.test(s.path || '');
  const items = {};
  for (const [id, rel] of Object.entries(db.itemRel)) {
    const r = rec('Item:' + id);
    if (!r.n) continue;
    const uniq = list => [...new Map(list.map(x => [JSON.stringify(x), x])).values()];
    const s = uniq(rel.sources.filter(isSource).map(x => row(x, true)));
    const u = uniq(rel.uses.map(x => row(x, false).concat([x.min])));
    const q = uniq(rel.requiredBy.map(x => row(x, false)));
    if (s.length || u.length || q.length) items[id] = { n: r.n, s, u, r: q };
  }
  return { gameVersion: db.gameVersion, items };
}

module.exports = { buildSpyglass };
