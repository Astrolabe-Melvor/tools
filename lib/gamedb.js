// Game database: turns MelvorBase.json into linked records for the wiki and tools.
// Every record of every type is indexed. References between records are found by walking the JSON,
// so new content shows up without code changes. Item sources/uses are classified from the field path.
const local = id => (typeof id === 'string' ? id.replace(/^MelvorBase:/, '') : id);
const isRef = v => typeof v === 'string' && v.startsWith('MelvorBase:');

const USE_KEYS = /(Ingredients|Costs?|Upkeep|Feed|Consumes)$/;
const SOURCE_KEYS = /(Products?|Drops|DropTable|Rewards?|Provides|Loot|Yield|Harvest|PerHit|PerCut)$/;
// UI/navigation records that reference everything and add noise to "referenced by".
const NOISE_TYPES = /NavigationOption$|^EntityPage$|^MusicTrack$|^Onboarding|^LegacySidebarCategory$/;
const REQ_KEYS = /Requirements$/;

function displayName(rec) {
  const n = rec.DisplayName;
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object') return n.Singular || n.Plural || rec.Id;
  return rec.Id;
}

function buildDb(data) {
  const o = data.Objects;
  const records = {};          // key "Type:Id" -> { t, id, n, d }
  const byId = {};             // Id -> [keys]
  for (const [type, list] of Object.entries(o)) {
    for (const rec of list) {
      const key = `${type}:${rec.Id}`;
      records[key] = { t: type, id: rec.Id, n: displayName(rec), d: rec };
      (byId[rec.Id] ||= []).push(key);
    }
  }
  const items = new Set((o.Item || []).map(i => i.Id));

  // Which skill/system each record belongs to.
  // 1) the skill named in its own Level requirement; 2) top-level membership lists in EntityConfig.
  const owner = {};
  for (const [key, r] of Object.entries(records)) {
    const lvl = (r.d.Requirements || []).find(q => local(q.Type) === 'Level' && q.Data?.Component?.Entity);
    if (lvl) owner[key] = local(lvl.Data.Component.Entity);
  }
  for (const [entity, cfg] of Object.entries(data.EntityConfig)) {
    const skill = local(entity);
    for (const list of Object.values(cfg)) {
      if (!Array.isArray(list)) continue;
      for (const x of list) {
        const id = isRef(x) ? x : x && isRef(x.Id) ? x.Id : null;
        if (!id) continue;
        // Ids are shared across types (Enemy:Wolf vs RanchingAnimal:Wolf); only claim an enemy when it's the sole match.
        const ks = (byId[local(id)] || []).filter(k => !k.startsWith('Item:'));
        for (const k of ks) if (!(k.startsWith('Enemy:') && ks.length > 1)) owner[k] ??= skill;
      }
    }
  }

  // Resolve a reference string to record keys, preferring the type the field name suggests.
  const resolve = (id, field) => {
    const keys = byId[id] || [];
    if (keys.length <= 1) return keys;
    const hint = (field || '').replace(/s$/, '');
    const exact = keys.filter(k => k.split(':')[0] === hint || k.split(':')[0].endsWith(hint));
    if (exact.length) return exact;
    if (/Item|Product|Drop|Reward|Ingredient|Cost/.test(field || '')) return keys.filter(k => k.startsWith('Item:'));
    return keys;
  };

  const refsIn = {};   // key -> Set of keys that reference it
  const itemRel = {};  // itemId -> { sources: [], uses: [], requiredBy: [] }
  const rel = id => (itemRel[id] ||= { sources: [], uses: [], requiredBy: [] });

  for (const [key, r] of Object.entries(records)) {
    const out = new Set();
    // path = list of field names from the record root
    const walk = (v, path, siblings) => {
      if (Array.isArray(v)) {
        const total = v.reduce((s, x) => s + (x && typeof x === 'object' && typeof x.Weight === 'number' ? x.Weight : 0), 0);
        v.forEach(x => walk(x, path, total));
        return;
      }
      if (v && typeof v === 'object') {
        if (isRef(v.Item) && items.has(local(v.Item))) {
          const p = path.join('.');
          const min = v.MinQuantity ?? v.Quantity ?? v.BaseQuantity ?? null;
          const max = v.MaxQuantity ?? min;
          const entry = { from: key, path: p, min, max,
            chance: v.Chance ?? null, share: siblings && typeof v.Weight === 'number' ? v.Weight / siblings : null };
          const top = path.find(x => USE_KEYS.test(x) || SOURCE_KEYS.test(x) || REQ_KEYS.test(x)) || '';
          const bucket = REQ_KEYS.test(top) ? 'requiredBy' : USE_KEYS.test(top) ? 'uses' : SOURCE_KEYS.test(top) ? 'sources' : null;
          if (bucket && !NOISE_TYPES.test(r.t)) rel(local(v.Item))[bucket].push(entry);
        }
        for (const [k, x] of Object.entries(v)) walk(x, [...path, k], 0);
        return;
      }
      if (isRef(v)) {
        const field = path[path.length - 1];
        for (const target of resolve(local(v), field)) if (target !== key) out.add(target);
      }
    };
    walk(r.d, [], 0);
    // Top-level single-item outputs not wrapped in an Item object (e.g. events, upgrades).
    const d = r.d;
    if (r.t === 'ItemUpgrade' && isRef(d.UpgradedItem)) rel(local(d.UpgradedItem)).sources.push({ from: key, path: 'UpgradedItem', min: d.QuantityPerUpgrade ?? 1, max: d.QuantityPerUpgrade ?? 1 });
    if (r.t === 'FishingRecipe' && isRef(d.JunkItem)) rel(local(d.JunkItem)).sources.push({ from: key, path: 'Junk', min: 1, max: 1, chance: 1 - (d.FishChance ?? 0) });
    if (r.t === 'AstrologyItemEvent' && isRef(d.Item)) rel(local(d.Item)).sources.push({ from: key, path: 'Item', min: d.BaseQuantity, max: d.BaseQuantity, chance: d.Chance });
    if (r.t === 'Item') {
      const op = d.Capabilities?.['MelvorBase:Openable'];
      if (op) {
        for (const x of op.AlwaysDrops || []) rel(local(x.Item)).sources.push({ from: key, path: 'Opened', min: x.Quantity, max: x.Quantity });
        const total = (op.DropTable || []).reduce((s, x) => s + x.Weight, 0) || 1;
        for (const x of op.DropTable || []) rel(local(x.Item)).sources.push({ from: key, path: 'Opened', min: x.MinQuantity, max: x.MaxQuantity, share: x.Weight / total });
      }
    }
    if (!NOISE_TYPES.test(r.t)) for (const t of out) (refsIn[t] ||= new Set()).add(key);
    r.refs = [...out];
  }
  // Openable items: drop-table entries were also caught by the walk under Capabilities; remove those duplicates.
  for (const v of Object.values(itemRel)) for (const b of ['sources', 'uses', 'requiredBy']) {
    const seen = new Set();
    v[b] = v[b].filter(e => { const k = e.from + '|' + e.path.replace(/^Capabilities.*/, 'Opened') + '|' + e.min + '|' + e.share; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  for (const [k, set] of Object.entries(refsIn)) if (records[k]) records[k].refBy = [...set];
  for (const [k, s] of Object.entries(owner)) if (records[k]) records[k].o = s;
  return { records, itemRel, entities: Object.keys(data.EntityConfig).map(local), types: Object.fromEntries(Object.entries(o).map(([t, l]) => [t, l.length])), entityConfig: data.EntityConfig, namespace: data.Namespace };
}

module.exports = { buildDb, local };
