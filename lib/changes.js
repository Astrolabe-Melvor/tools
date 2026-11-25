// What changed in the game data between two wiki builds. build-wiki.js keeps a running history in changes.json
// next to the published wiki.json, so each game update adds one entry (newest first).
const SKIP = /NavigationOption$|^EntityPage$|^MusicTrack$|^Legacy|^Custom|Background$/;
const MAX_FIELDS = 40, MAX_TEXT = 160, KEEP = 25;

// Leaf values of a record's data by path ("Capabilities.Equipment.Stats.Stats.0.Value").
// Lists of stats, drops and costs are keyed by what they are ("Stats.AttackInterval.Value"), not their position,
// so a reordered list doesn't read as a change.
const ID_FIELDS = ['Stat', 'Key', 'Item', 'DamageType', 'Currency', 'Id', 'Skill', 'Enemy', 'Attack', 'Stance'];
function idOf(x) { if (!x || typeof x !== 'object') return null; for (const f of ID_FIELDS) if (typeof x[f] === 'string') return x[f].replace(/^MelvorBase:/, ''); return null; }
// out: leaf path -> value; nodes: every object path -> the object (to show a whole added or removed part as one line).
function flatten(v, p = '', out = {}, nodes = {}) {
  if (v && typeof v === 'object') {
    nodes[p] = v;
    const keys = Object.keys(v);
    if (!keys.length) out[p] = Array.isArray(v) ? '[]' : '{}';
    const ids = Array.isArray(v) ? v.map(idOf) : null;
    const keyed = ids && ids.every(Boolean) && new Set(ids).size === ids.length;
    keys.forEach((k, i) => flatten(v[k], (p ? p + '.' : '') + (keyed ? ids[i] : k), out, nodes));
  } else out[p] = v;
  return out;
}
// Drop nulls and empty lists/objects so "added an empty field" isn't a change.
const prune = v => { if (Array.isArray(v)) { const a = v.map(prune).filter(x => x != null); return a.length ? a : null; }
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { const y = prune(x); if (y != null && y !== '') o[k] = y; } return Object.keys(o).length ? o : null; }
  return v; };
// "Capabilities.MelvorBase:Equipment.Stats.Stats.AttackInterval.Value" -> "Equipment stats: AttackInterval"
const pretty = p => p.replace(/MelvorBase:/g, '').replace(/^Capabilities\./, '').replace(/\.Stats\.Stats\./, ' stats: ').replace(/\.Value$/, '').replace(/\.(\w)/g, ' > $1');
const short = v => { const s = typeof v === 'string' ? v.replace(/^MelvorBase:/, '') : JSON.stringify(v); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '...' : s; };

function diffDb(prev, next) {
  const add = [], rem = [], chg = [];
  const A = prev.records || {}, B = next.records || {};
  for (const [k, r] of Object.entries(B)) {
    if (SKIP.test(r.t)) continue;
    const o = A[k];
    if (!o) { add.push({ k, n: r.n, t: r.t }); continue; }
    if (JSON.stringify(o.d) === JSON.stringify(r.d)) continue;
    if (JSON.stringify(prune(o.d)) === JSON.stringify(prune(r.d))) continue;
    const na = {}, nb = {}, fa = flatten(prune(o.d) || {}, '', {}, na), fb = flatten(prune(r.d) || {}, '', {}, nb), f = [], seen = new Set();
    // A part that exists on only one side is shown once, at its top, as a whole.
    const top = (p, other, nodes) => { const seg = p.split('.'); let q = p; for (let i = seg.length - 1; i > 0; i--) { const up = seg.slice(0, i).join('.'); if (up in other || !(up in nodes)) break; q = up; } return q; };
    for (const p of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (fa[p] === fb[p]) continue;
      if (p in fa && p in fb) { f.push({ p: pretty(p), a: short(fa[p]), b: short(fb[p]) }); continue; }
      const q = p in fb ? top(p, { ...na, ...fa }, nb) : top(p, { ...nb, ...fb }, na);
      if (seen.has(q)) continue; seen.add(q);
      const va = q in na ? na[q] : fa[q], vb = q in nb ? nb[q] : fb[q];
      f.push({ p: pretty(q), a: va === undefined ? null : short(va), b: vb === undefined ? null : short(vb) });
    }
    if (f.length) chg.push({ k, n: r.n, t: r.t, f: f.slice(0, MAX_FIELDS), more: Math.max(0, f.length - MAX_FIELDS) });
  }
  for (const [k, r] of Object.entries(A)) if (!B[k] && !SKIP.test(r.t)) rem.push({ k, n: r.n, t: r.t });
  return { add, rem, chg };
}

// Returns the new history (or the old one when nothing changed).
function updateHistory(prevDb, nextDb, history) {
  history = Array.isArray(history) ? history : [];
  if (!prevDb?.records) return history;
  const d = diffDb(prevDb, nextDb);
  if (!d.add.length && !d.rem.length && !d.chg.length) return history;
  return [{ from: prevDb.gameVersion || '', to: nextDb.gameVersion || '', fromBuilt: prevDb.built || '', built: nextDb.built || '', ...d }, ...history].slice(0, KEEP);
}

module.exports = { diffDb, updateHistory };
