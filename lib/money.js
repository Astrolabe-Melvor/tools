// Money calculator: builds every gold-producing action from the game data and rates it for a save.
// Applies bonuses from equipped toolbelt items (gear, tools, potions, keys) and account bonuses
// (shop purchases, pets, mastery ranks, astrology nodes) from lib/bonuses.js.
const local = id => (id || '').replace(/^MelvorBase:/, '');
const { checkCondition } = require('./bonuses');
const GOLD = 'MelvorBase:GoldPieces';
const clamp01 = x => Math.max(0, Math.min(1, x));
const CONTEXT_KEYS = ['Recipe', 'Category', 'Subcategory', 'Location', 'RecipeType', 'Item', 'Animal', 'Tool', 'TrapType', 'Course', 'Obstacle', 'Technique', 'Path', 'Plot'];
const MATCH_KEYS = CONTEXT_KEYS.filter(k => k !== 'Item').map(k => k.toLowerCase());

// Mining (MiningActionComponent): each hit breaks the rock with chance p; otherwise progress += p,
// and the rock breaks anyway once progress reaches 0.9999. After a break, progress resets to the
// minimum-prospecting value m. Returns expected hits per break.
function miningHits(p, m = 0) {
  p = clamp01(p);
  if (p >= 1) return 1;
  if (p <= 0) return Infinity;
  let k = 1;
  while (m + k * p < 0.9999) k++;
  let e = 0, miss = 1;
  for (let i = 1; i < k; i++) { e += i * miss * p; miss *= 1 - p; }
  return e + k * miss;
}

// Woodcutting (WoodcuttingActionComponent): each hit deals 1 damage; weak spot deals 3 + floor(10% max HP);
// double damage doubles it; instant cut finishes the tree. Returns expected hits per log.
function woodHits(health, instant, weak, dbl) {
  const hits = [0, 1], weakDmg = 3 + Math.floor(0.1 * health);
  for (let hp = 2; hp <= health; hp++) {
    const after = d => hits[Math.max(0, hp - d)];
    const normal = (1 - dbl) * after(1) + dbl * after(2);
    const weakHit = (1 - dbl) * after(weakDmg) + dbl * after(2 * weakDmg);
    hits[hp] = 1 + (1 - instant) * ((1 - weak) * normal + weak * weakHit);
  }
  return hits[health];
}

// Expected actions to finish N steps when each action can skip one extra step with chance p.
function expectedSteps(n, p) {
  let two = 0, one = 1;
  for (let k = 2; k <= n; k++) { const e = 1 + (1 - p) * one + p * two; two = one; one = e; }
  return n <= 0 ? 1 : one;
}

function modRow(b, value) {
  const ctx = b.LocalContext || {};
  const row = { stat: b.Stat?.Name, value, skill: local(ctx.Component?.Entity), part: ctx.Component?.Component };
  for (const k of CONTEXT_KEYS) if (ctx[k]) row[k.toLowerCase()] = local(ctx[k]);
  return row;
}
// Account bonus entries -> the same row shape as toolbelt bonuses.
function accountRows(acct) {
  const rows = [];
  let xp = 0, interval = 0;
  for (const e of acct?.entries || []) {
    if (e.global === 'GlobalPercentXpGained') xp += e.value;
    else if (e.global === 'GlobalPercentActionInterval') interval += e.value;
    else if (e.m && !e.m.Condition && !e.m.Scaling && !e.m.FromContext) rows.push({ ...modRow(e.m, e.m.Value * e.mult), from: e.src });
  }
  return { rows, xp, interval };
}

// Hunting journal XP curve (HuntingAnimalExperienceTable), cap 25.
const huntXp = L => L <= 1 ? 0 : Math.floor((L * L - L + 100 * (2 ** (L / 3.5) - 2 ** (1 / 7)) / (2 ** (1 / 7) - 1)) / 12);
function huntLevel(xp) { let L = 1; while (L < 25 && xp >= huntXp(L + 1)) L++; return L; }

function itemBonuses(item) {
  const tool = item.Capabilities?.['MelvorBase:Toolbelt'];
  if (!tool) return null;
  const rows = (tool.Bonuses?.Component || []).filter(b => !b.Condition && !b.Scaling && !b.FromContext).map(b => {
    const ctx = b.LocalContext || {};
    const row = { stat: b.Stat?.Name, value: b.Value, skill: local(ctx.Component?.Entity), part: ctx.Component?.Component };
    for (const k of CONTEXT_KEYS) if (ctx[k]) row[k.toLowerCase()] = local(ctx[k]);
    return row;
  });
  return { rows, charges: !!tool.ConsumesOn };
}

function buildCatalog(data) {
  const o = data.Objects;
  const items = {};
  for (const it of o.Item) {
    items[local(it.Id)] = {
      name: it.DisplayName?.Singular || it.Id,
      price: it.SellsFor?.Currency === GOLD ? it.SellsFor.Quantity : 0,
      tool: itemBonuses(it),
    };
  }
  const byId = type => new Map((o[type] || []).map(r => [r.Id, r]));
  const parents = new Map(['RecipeCategory', 'WoodcuttingRecipeCategory', 'MiningRecipeCategory', 'FishingLocation', 'ThievingLocation']
    .flatMap(t => (o[t] || []).map(r => [r.Id, r])));
  const reqs = record => ['Requirements', 'AccessRequirements', 'SecondaryRequirements']
    .flatMap(k => record?.[k] || []).map(({ Type, Data }) => ({
      type: local(Type), skill: local(Data?.Component?.Entity), level: Data?.Level, item: local(Data?.Item), or: !!Data?.IsOr, raw: { Type, Data },
    }));
  const weighted = (table = []) => {
    const total = table.reduce((s, r) => s + r.Weight, 0) || 1;
    return table.map(r => ({ id: local(r.Item), qty: (r.MinQuantity + r.MaxQuantity) / 2, share: r.Weight / total }));
  };
  const included = skill => new Set((data.EntityConfig['MelvorBase:' + skill]?.Recipes || []).map(x => local(x.Id)));
  const actions = [];
  const add = (skill, kind, r, fields) => {
    const parent = parents.get(local(r.Location ?? r.Category));
    actions.push({
      id: `${skill}:${r.Id}`, skill, kind, name: r.DisplayName, area: parent?.DisplayName || null,
      ctx: { recipe: r.Id, category: local(r.Category), subcategory: local(r.Subcategory), location: local(r.Location), recipetype: local(r.RecipeType) },
      xp: r.BaseExperience || 0, requirements: [...reqs(parent), ...reqs(r)],
      interval: r.BaseInterval || 0, steps: 1, inputs: [], outputs: [], ...fields,
    });
  };
  const product = (p, main = true) => ({ id: local(p.Item), qty: p.Quantity * (p.Chance ?? 1), main });
  const ingredients = r => (r.Ingredients?.Items || []).map(i => ({ id: local(i.Item), qty: i.Quantity }));

  const wc = included('Woodcutting');
  for (const r of o.WoodcuttingRecipe) {
    if (!wc.has(r.Id) || !r.Product || !(r.BaseMaxHealth > 0)) continue;
    add('Woodcutting', 'Woodcutting', r, {
      hits: r.BaseMaxHealth,
      outputs: [product(r.Product), ...r.RandomProductsPerCut.map(p => product(p, false))],
      perHit: r.RandomProductsPerHit.map(p => product(p, false)),
    });
  }
  const mn = included('Mining');
  for (const r of o.MiningRecipe) {
    if (!mn.has(r.Id) || !r.Product) continue;
    add('Mining', 'Mining', r, {
      breakChance: r.BaseProductChance, bar: local(r.BarItem),
      outputs: [{ id: local(r.Product.Item), qty: r.Product.Quantity, main: true }],
      perHit: r.RandomProductsPerHit.map(p => product(p, false)),
    });
  }
  const fi = included('Fishing');
  for (const r of o.FishingRecipe) {
    if (!fi.has(r.Id)) continue;
    add('Fishing', 'Fishing', r, {
      minInterval: r.BaseMinInterval, maxInterval: r.BaseMaxInterval,
      outputs: [
        ...weighted(r.RandomProducts).map(f => ({ id: f.id, qty: f.qty * f.share * r.FishChance, main: true })),
        ...(r.JunkItem ? [{ id: local(r.JunkItem), qty: 1 - r.FishChance, main: false }] : []),
        ...(r.SpecialProducts || []).map(p => product(p, false)),
      ],
    });
  }
  const th = included('Thieving');
  for (const r of o.ThievingRecipe) {
    if (!th.has(r.Id)) continue;
    const cash = r.CurrencyReward?.Currency === GOLD ? (r.CurrencyReward.MinQuantity + r.CurrencyReward.MaxQuantity) / 2 : 0;
    add('Thieving', 'Thieving', r, {
      perception: r.Perception, cash: cash * r.BaseCurrencyLootChance, stages: Math.max(1, r.Stages || 1),
      outputs: [
        ...weighted(r.CommonDropTable).map(d => ({ id: d.id, qty: d.qty * d.share * r.BaseCommonLootChance, loot: true })),
        ...weighted(r.RareDropTable).map(d => ({ id: d.id, qty: d.qty * d.share * r.BaseRareLootChance, loot: true })),
        ...weighted(r.CompletionDropTable).map(d => ({ id: d.id, qty: d.qty * d.share, loot: true, completion: true })),
      ],
    });
  }
  const artisan = byId('ArtisanRecipe');
  for (const skill of ['Smithing', 'Crafting', 'Fletching', 'Runecrafting', 'Beastcrafting']) {
    for (const id of included(skill)) {
      const r = artisan.get(id);
      if (!r || !r.Products?.length) continue;
      add(skill, 'Artisan', r, {
        steps: Math.max(1, r.Steps || 1), inputs: ingredients(r), outputs: r.Products.map(p => product(p)),
        goldCost: (r.Ingredients?.Currencies || []).filter(c => c.Currency === GOLD).reduce((s, c) => s + c.Quantity, 0),
      });
    }
  }
  const co = included('Cooking');
  for (const r of o.CookingRecipe) {
    if (!co.has(r.Id) || !r.Products?.length) continue;
    add('Cooking', 'Cooking', r, { steps: Math.max(1, r.Steps || 1), difficulty: r.Difficulty || 0, inputs: ingredients(r), outputs: r.Products.map(p => product(p)) });
  }

  // Herblore: a batch = prepare + heat + stir + 10 bottlings; each bottling uses ingredients and makes products.
  const hb = included('Herblore');
  for (const r of o.HerbloreRecipe || []) {
    if (!hb.has(r.Id) || !r.Products?.length) continue;
    add('Herblore', 'Herblore', r, {
      phases: [r.BasePreparingInterval, r.BaseHeatingInterval, r.BaseStirringInterval, r.BaseBottlingInterval],
      inputs: ingredients(r), outputs: [product([...r.Products].sort((x, y) => (x.Chance ?? 1) - (y.Chance ?? 1))[0])],
    });
  }

  // Hunting: survey -> track -> trap. Trap items come from the bank (best owned trap of the animal's type).
  const traps = {};
  for (const it of o.Item) { const t = it.Capabilities?.['MelvorBase:HuntingTrap']; if (t) (traps[local(t.TrapType)] ||= []).push({ id: local(it.Id), bonuses: t.TrapBonuses || [], fail: t.FailBonuses || [] }); }
  // Journal level bonuses apply per animal once its journal reaches the level.
  const journalBonuses = (o.HuntingJournalBonus || []).map(b => ({ level: b.UnlockLevel, mods: b.JournalModifierTemplate || [] }));
  const huntLoc = byId('HuntingLocation');
  const hu = new Set((data.EntityConfig['MelvorBase:Hunting']?.Animals || []).map(x => local(x.Id)));
  for (const r of o.HuntingAnimal || []) {
    if (!hu.has(local(r.Id))) continue;
    const loc = huntLoc.get(local(r.Location));
    actions.push({
      id: `Hunting:${r.Id}`, skill: 'Hunting', kind: 'Hunting', name: r.DisplayName, area: loc?.DisplayName || null,
      ctx: { animal: local(r.Id), location: local(r.Location), tool: local(r.Tool), traptype: local(r.TrapType) },
      xp: r.BaseExperience || 0, requirements: [...reqs(loc), ...reqs(r)], interval: 0, steps: 1, inputs: [],
      animal: r, survey: loc?.BaseSurveyInterval || 4000, surveyXp: loc?.BaseSurveyingExperience || 0,
      traps: traps[local(r.TrapType)] || [], toolName: local(r.Tool), journalBonuses, bait: local(r.PreferredBait), baitMods: r.BaitModifierTemplate || [],
      outputs: (r.Products || []).map(p => ({ id: local(p.Item), qty: p.Quantity * (p.Chance ?? 1), main: true })),
      surveyOut: (r.SurveyingProducts || []).map(p => ({ id: local(p.Item), qty: p.Quantity, chance: p.Chance ?? 1 })),
    });
  }

  // Agility: one action = one full course path. Obstacles, technique and difficulty decide the failure rate.
  const obst = byId('AgilityObstacle'), paths = byId('AgilityCoursePath'), agLoc = byId('AgilityLocation');
  const ag = new Set((data.EntityConfig['MelvorBase:Agility']?.Courses || []).map(x => local(x.Id)));
  for (const c of o.AgilityCourse || []) {
    if (!ag.has(local(c.Id))) continue;
    for (const pid of c.Paths || []) {
      const p = paths.get(local(pid));
      if (!p) continue;
      const obs = (p.Obstacles || []).map(x => obst.get(local(x))).filter(Boolean);
      actions.push({
        id: `Agility:${c.Id}:${p.Id}`, skill: 'Agility', kind: 'Agility', name: `${c.DisplayName}${c.Paths.length > 1 ? ' (' + (p.DisplayName || local(p.Id).replace(c.Id, '').replace(/Path$/, '')) + ')' : ''}`,
        area: agLoc.get(local(c.Location))?.DisplayName || null,
        ctx: { course: local(c.Id), path: local(p.Id), location: local(c.Location) },
        xp: p.BaseExperience || 0, requirements: reqs(c), interval: 0, steps: 1,
        obstacles: obs.map(x => ({ id: local(x.Id), interval: x.BaseInterval, technique: local(x.Technique), difficulty: x.Difficulty, damage: x.Damage, trap: !!x.IsTrap })),
        entry: ingredients({ Ingredients: c.EntryCost }), entryGold: (c.EntryCost?.Currencies || []).filter(x => x.Currency === GOLD).reduce((a, x) => a + x.Quantity, 0),
        inputs: [],
        outputs: [
          ...(c.CompletionRewards?.Items || []).map(x => ({ id: local(x.Item), qty: x.Quantity, main: true, reward: true })),
          ...(p.RandomObstacleProducts || []).map(x => ({ id: local(x.Item), qty: x.Quantity * x.Chance, main: false, obstacle: true })),
        ],
        cashReward: (c.CompletionRewards?.Currencies || []).filter(x => x.Currency === GOLD).reduce((a, x) => a + x.Quantity, 0),
        techXp: c.GivesTechniqueXP ? p.BaseTechniqueExperience || 0 : 0,
      });
    }
  }

  const fm = included('Firemaking');
  for (const r of o.FiremakingRecipe || []) {
    if (!fm.has(r.Id)) continue;
    add('Firemaking', 'Firemaking', r, { inputs: ingredients(r), outputs: (r.Products || []).map(p => product(p, false)) });
  }
  const passive = {
    farmRecipes: byId('FarmingRecipe'), farmCats: byId('FarmingCategory'), plots: byId('FarmingPlot'),
    compost: new Map(o.Item.filter(i => i.Capabilities?.['MelvorBase:Compost']).map(i => [local(i.Id), i.Capabilities['MelvorBase:Compost'].CompostModifierTemplate || []])),
    animals: byId('RanchingAnimal'),
    farmIncluded: included('Farming'),
  };
  return { items, actions, passive };
}

// Sum the stats from equipped items that apply to this action (and, if given, this output item).
function statFor(a, equipped, items, extra = []) {
  const rows = [];
  const fits = r => r.skill === a.skill && !MATCH_KEYS.some(k => r[k] && r[k] !== a.ctx[k]);
  for (const id of equipped[a.skill] || []) for (const r of items[id]?.tool?.rows || []) if (fits(r)) rows.push({ ...r, from: id });
  for (const r of extra) if (fits(r)) rows.push(r);
  const stat = (name, item) => rows.filter(r => r.stat === name && (!r.item || r.item === item)).reduce((s, r) => s + r.value, 0);
  return { stat, rows };
}

function evaluate(catalog, { levels, bank, toolbelts = {}, useGear = true, extraStealth = 0, countInputs = true, hours = 8, acct = null, journal = {} }) {
  const { items } = catalog;
  const ac = accountRows(acct);
  const acctTech = acct?.techLevels || {};
  const price = id => items[id]?.price ?? 0;
  const name = id => items[id]?.name ?? id;
  const equipped = useGear ? toolbelts : {};
  const results = [];
  for (const a of catalog.actions) {
    const level = levels[a.skill] ?? 1;
    const missing = [], notes = [];
    const owned = id => (bank[id] ?? 0) > 0 || Object.values(toolbelts).some(l => l.includes(id));
    // Item requirements: consecutive "or" entries form one group; groups are ANDed.
    const groups = [];
    for (const q of a.requirements.filter(q => q.type === 'ToolbeltItemEquipped')) {
      if (q.or && groups.length) groups[groups.length - 1].push(q); else groups.push([q]);
    }
    for (const g of groups) {
      const have = g.filter(q => owned(q.item));
      if (!have.length) missing.push(g.map(q => name(q.item)).join(' or '));
      else notes.push('equip ' + have.map(q => name(q.item)).join(' or '));
    }
    if (a.area === 'Quests') notes.push('quest only');
    for (const q of a.requirements) {
      if (q.type === 'Level') { if ((levels[q.skill] ?? 1) < q.level) missing.push(`${q.skill} ${q.level}`); }
      else if (q.type !== 'ToolbeltItemEquipped') {
        const ok = acct ? checkCondition(q.raw, acct.ctx) : null;
        const label = q.type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^Quest.*/, 'quest requirement');
        if (ok === false) missing.push(label.toLowerCase() + (q.raw?.Data?.Level ? ' ' + q.raw.Data.Level : ''));
        else if (ok === null) notes.push(label);
      }
    }
    const { stat: stat0, rows } = statFor(a, equipped, items, ac.rows);
    // Global bonuses (astrology events, etc.) apply to every skill.
    const stat = (n, item) => stat0(n, item) + (n === 'PercentXPGained' ? ac.xp : n === 'PercentInterval' ? ac.interval : 0);
    // Gathering/thieving: floor((base + flat) * (1 + pct)). Artisan/cooking: floor(base * (1 + pct) + flat).
    const intervalMs = base => Math.max(100, Math.floor(['Artisan', 'Cooking'].includes(a.kind)
      ? base * (1 + stat('PercentInterval')) + stat('FlatInterval')
      : (base + stat('FlatInterval')) * (1 + stat('PercentInterval'))));

    // Hunting, Agility and Herblore have their own cycles; they produce per-cycle quantities here and
    // share the gold/XP bookkeeping below.
    let custom = null;
    if (a.kind === 'Herblore') {
      const ph = (base, n) => Math.max(0, Math.floor(base * (1 + stat('Percent' + n + 'Interval')) + stat('Flat' + n + 'Interval')));
      const [pr, he, st, bo] = a.phases;
      const batch = ph(pr, 'Preparing') + ph(he, 'Heating') + ph(st, 'Stirring') + 10 * ph(bo, 'Bottling');
      const o0 = a.outputs[0];
      const q = Math.max(1, Math.floor((o0.qty + stat('FlatProductQuantity', o0.id)) * (1 + stat('PercentProductQuantity', o0.id)))) * (1 + clamp01(stat('DoublingChance')));
      custom = { seconds: batch / 1000, out: [[o0.id, 10 * q]], inp: a.inputs.map(x => [x.id, 10 * x.qty * (1 - clamp01(stat('PreservationChance')))]), xp: 10 * (a.xp + stat('FlatXPGained')), unit: 'batch of 10' };
    } else if (a.kind === 'Hunting') {
      const an = a.animal, j = journal[an.Id] || journal[local(an.Id)] || {};
      const L = j.xp ? huntLevel(j.xp) : 1;
      // Pick the best trap owned (or the first one, flagged).
      const owned = a.traps.filter(t => (bank[t.id] ?? 0) > 0);
      const choices = owned.length ? owned : a.traps.slice(0, 1);
      let best = null;
      for (const t of choices) {
        // Trap bonuses, plus the preferred bait's bonuses when it's in the bank (bait is used once per trap attempt).
        const useBait = a.bait && (bank[a.bait] ?? 0) > 0;
        const tb = [...t.bonuses, ...(useBait ? a.baitMods : []), ...a.journalBonuses.filter(jb => jb.level <= L).flatMap(jb => jb.mods)].map(b => modRow(b, b.Value));
        const S = (n, item) => stat(n, item) + tb.filter(r => r.stat === n && (!r.item || r.item === item)).reduce((x, r) => x + r.value, 0);
        const iv = (lo, hi, kind) => {
          const f = (b, mm) => Math.floor((b + S('Flat' + mm + kind + 'Interval') + S('Flat' + kind + 'Interval')) * (1 + S('Percent' + mm + kind + 'Interval') + S('Percent' + kind + 'Interval')));
          const mn = f(lo, 'Min'), mx = Math.max(mn, f(hi, 'Max'));
          return (mn + mx) / 2;
        };
        const survey = Math.floor((a.survey + S('FlatSurveyInterval')) * (1 + S('PercentSurveyInterval')));
        const pt = clamp01(an.BaseTrackSuccessChance + S('FlatTrackingSuccessChance') + an.BaseTrackSuccessChance * S('IncreasedTrackingSuccessChance'));
        const q = clamp01(an.BaseTrapSuccessChance + S('FlatTrappingSuccessChance') + an.BaseTrapSuccessChance * S('IncreasedTrappingSuccessChance'));
        const smin = Math.floor(an.BaseMinTrackingSteps + S('FlatMinTrackingSteps') + S('FlatTrackingSteps'));
        const smax = Math.max(smin, Math.floor(an.BaseMaxTrackingSteps + S('FlatMaxTrackingSteps') + S('FlatTrackingSteps')));
        const skip = clamp01(S('SkipTrackingStepChance'));
        const tTrack = iv(an.BaseMinTrackInterval, an.BaseMaxTrackInterval, 'Tracking'), tTrap = iv(an.BaseMinTrapInterval, an.BaseMaxTrapInterval, 'Trapping');
        const discovered = j.xp > 0 || j.discovered;
        let steps = 0;
        if (discovered) { for (let n = smin; n <= smax; n++) steps += expectedSteps(n, skip); steps /= (smax - smin + 1); } else steps = expectedSteps(smax * 4, skip);
        const surveys = 1 + (1 - pt) + (1 - pt) ** 2;
        const re = clamp01(S('TrappingReattemptChance'));
        // Each failed attempt adds the trap's fail bonus (e.g. +5% for reinforced) until the next catch.
        const failStep = t.fail.filter(b => b.Stat?.Name === 'FlatTrappingSuccessChance').reduce((x, b) => x + b.Value, 0);
        let attempts = 0, fails = 0, reach = 1;
        for (let k = 0; k < 200 && reach > 1e-9; k++) { const qk = clamp01(q + failStep * k); attempts += reach; fails += reach * (1 - qk); reach *= 1 - qk; }
        const ms = q > 0 || failStep > 0 ? (surveys * survey + steps * tTrack + attempts * tTrap + fails * (1 - re) * expectedSteps(smin, skip) * tTrack) : Infinity;
        const num = 0.9 + L / 100; // average size/weight score at this journal level
        const rare = clamp01(an.BaseRareSpeciesChance + S('FlatRareSpeciesChance') + an.BaseRareSpeciesChance * S('IncreasedRareSpeciesChance'));
        const dbl = 1 + clamp01(S('DoublingChance'));
        const out = a.outputs.map(x => [x.id, Math.max(1, Math.max(0, Math.floor((x.qty + S('FlatProductQuantity', x.id)) * (1 + S('PercentProductQuantity', x.id)))) * num) * dbl * (1 + rare)]);
        for (const sp of a.surveyOut) out.push([sp.id, (1 - (1 - sp.chance) ** surveys) * sp.qty * dbl]);
        const trapsUsed = attempts * (1 - clamp01(S('PreservationChance')));
        const inpH = [[t.id, trapsUsed]];
        if (useBait) inpH.push([a.bait, attempts]);
        const c = { seconds: ms / 1000, out, inp: inpH, bait: useBait, xp: (a.xp + S('FlatXPGained')) * num + surveys * a.surveyXp, unit: 'catch', trap: t.id, owned: owned.length > 0, L, q, discovered };
        const v = c.out.reduce((x, [id, qq]) => x + qq * price(id), 0) - inpH.reduce((x, [id, qq]) => x + qq * price(id), 0);
        if (!best || v / c.seconds > best.v / best.c.seconds) best = { c, v };
      }
      if (best) {
        custom = best.c;
        notes.push(`trap: ${name(custom.trap)}${custom.owned ? '' : ' (none in bank)'}`, `journal ${custom.L}`, `trap ${Math.round(custom.q * 100)}%`);
        if (custom.bait) notes.push('with bait');
        if (!custom.discovered) notes.push('undiscovered: 4x tracking');
        if (a.toolName) notes.push('tool: ' + a.toolName.replace(/([a-z])([A-Z])/g, '$1 $2'));
      }
    } else if (a.kind === 'Agility') {
      // Each obstacle: success from technique level vs difficulty; a fail restarts the run (and repays entry).
      let reach = 1, tAttempt = 0, dmg = 0;
      const lv = acctTech || {};
      for (const ob of a.obstacles) {
        const os = statFor({ ...a, ctx: { ...a.ctx, obstacle: ob.id, technique: ob.technique } }, equipped, items, ac.rows).stat;
        const t = Math.floor((ob.interval + os('FlatInterval')) * (1 + os('PercentInterval')));
        let sc;
        if (ob.trap) sc = Math.min(0.95, Math.max(0, 0.8 + os('FlatTrapSuccessChance')));
        else if (!ob.technique) sc = 0.6;
        else { const gap = Math.max(0, Math.max(0, ob.difficulty + os('FlatObstacleDifficulty')) - (lv[ob.technique] || 1) + 1); sc = gap > 0 ? 0.95 ** (gap / 2) : 1; }
        tAttempt += reach * t;
        dmg += reach * (1 - sc) * (1 + Math.max(1, Math.floor(ob.damage * (1 + os('PercentDamageTaken'))))) / 2 * (1 - clamp01(os('AvoidDamageChance')));
        reach *= sc;
      }
      const attempts = reach > 0 ? 1 / reach : Infinity;
      const rq = 1 + stat('PercentRewardQuantity');
      const out = a.outputs.map(x => [x.id, x.obstacle ? Math.max(1, Math.floor((x.qty / 1 + stat('FlatObstacleRewardQuantity')) * (1 + stat('PercentObstacleRewardQuantity')))) * (1 + clamp01(stat('DoublingChance'))) : Math.max(1, Math.floor(x.qty * rq))]);
      // Obstacle reward: x.qty already includes chance; recompute expected as chance * quantity
      for (let i = 0; i < a.outputs.length; i++) if (a.outputs[i].obstacle) out[i][1] = a.outputs[i].qty * (1 + clamp01(stat('DoublingChance')));
      const keep = 1 - clamp01(stat('EntryCostPreservationChance'));
      custom = { seconds: tAttempt * attempts / 1000, out, inp: a.entry.map(x => [x.id, x.qty * attempts * keep]), xp: a.xp + stat('FlatXPGained'), cash: a.cashReward * rq - a.entryGold * attempts * keep, unit: 'run' };
      notes.push(`${Math.round(reach * 100)}% clean runs`);
      if (dmg * attempts > 0.5) notes.push(`${Math.round(dmg * attempts)} dmg/run`);
      if (a.techXp) notes.push(`+${a.techXp} technique XP/run`);
    }
    if (custom) {
      const perHour = isFinite(custom.seconds) && custom.seconds > 0 ? 3600 / custom.seconds : 0;
      const out = custom.out.filter(([, q]) => q > 0).map(([id, q]) => ({ id, name: name(id), perHour: q * perHour, value: q * perHour * price(id) })).sort((p, q) => q.value - p.value);
      const inp = custom.inp.filter(([, q]) => q > 0).map(([id, q]) => { const ph = q * perHour, have = bank[id] ?? 0; return { id, name: name(id), perHour: ph, value: ph * price(id), have, hoursLeft: ph > 0 ? have / ph : Infinity }; });
      const cashH = (custom.cash || 0) * perHour;
      const sales = out.reduce((x, o2) => x + o2.value, 0) + Math.max(0, cashH);
      const inputValue = inp.reduce((x, i2) => x + i2.value, 0) + Math.max(0, -cashH);
      const gpPerHour = sales - (countInputs ? inputValue : Math.max(0, -cashH));
      const stockHours = inp.length ? Math.min(...inp.map(x => x.hoursLeft)) : Infinity;
      const runHours = Math.min(hours, stockHours);
      results.push({
        id: a.id, skill: a.skill, name: a.name, area: a.area, unlocked: missing.length === 0, missing, notes,
        seconds: custom.seconds, success: custom.q ?? 1, gpPerHour, sales, inputValue, cashPerHour: Math.max(0, cashH),
        xpPerHour: custom.xp * perHour * (1 + stat('PercentXPGained')), outputs: out, inputs: inp, stockHours, runHours, totalForHours: gpPerHour * runHours,
        unit: custom.unit, gear: [...new Set(rows.filter(r => !/:| mastery$/.test(r.from)).map(r => name(r.from)))],
        account: [...new Set(rows.filter(r => /:| mastery$/.test(r.from)).map(r => r.from))],
      });
      continue;
    }

    let seconds;
    if (a.kind === 'Fishing') {
      const lo = Math.max(100, (a.minInterval + stat('FlatInterval')) * (1 + stat('PercentInterval') + stat('PercentMinInterval')));
      const hi = Math.max(lo, (a.maxInterval + stat('FlatInterval')) * (1 + stat('PercentInterval') + stat('PercentMaxInterval')));
      seconds = (lo + hi) / 2000;
    } else if (a.kind === 'Woodcutting') {
      const health = Math.max(1, Math.ceil((a.hits + stat('FlatMaxHealth')) * (1 + stat('PercentMaxHealth'))));
      a._hits = woodHits(health, clamp01(stat('InstantCutChance')), clamp01(stat('WeakSpotChance')), clamp01(stat('DoubleDamageChance')));
      seconds = intervalMs(a.interval) / 1000 * a._hits;
    } else if (a.kind === 'Mining') {
      a._hits = miningHits(a.breakChance * (1 + stat('PercentIncreaseRockBreakChance')), stat('FlatMinimumProspecting'));
      seconds = intervalMs(a.interval) / 1000 * a._hits;
    } else {
      seconds = intervalMs(a.interval) / 1000 * (a.kind === 'Artisan' ? expectedSteps(a.steps, clamp01(stat('SkipStepChance'))) : a.steps);
    }

    let success = 1, cash = 0, lootMult = 1;
    const stagesE = a.stages > 1 ? expectedSteps(Math.max(1, a.stages + stat('FlatStages')), clamp01(stat('SkipStageChance'))) : 1;
    if (a.stages > 1) notes.push(`heist: ${a.stages} stages`);
    if (a.kind === 'Thieving') {
      const stealth = level + stat('FlatStealth') + extraStealth;
      success = clamp01((100 + stealth) / (100 + a.perception));
      seconds += (1 - success) * 2 * (1 - clamp01(stat('StunAvoidanceChance')));
      lootMult = (1 + (stat('FlatFortune') + (success < 1 ? stat('FlatFortuneUnderSuccess') : 0)) / 100) * (1 + clamp01(stat('DoublingChance')));
      cash = success * a.cash * (1 + stat('PercentCurrencyReward')) * clamp01(1 + stat('PercentCurrencyLootChance'));
    } else if (a.kind === 'Cooking') {
      success = clamp01((69 + level + stat('FlatProficiency')) / (69 + a.difficulty));
    }
    const doubling = a.kind === 'Thieving' ? 1 : 1 + clamp01(stat('DoublingChance'));
    const perHour = 3600 / seconds;
    const outQty = new Map();
    const addOut = (id, q) => q > 0 && outQty.set(id, (outQty.get(id) || 0) + q);
    for (const x of a.outputs) {
      let q = x.qty;
      if (x.main) {
        q = (q + stat('FlatProductQuantity', x.id) * (x.qty > 0 ? Math.min(1, x.qty) : 0)) * (1 + stat('PercentProductQuantity', x.id)) * doubling;
        if (a.kind === 'Mining') q = (q + clamp01(stat('AdditionalProductQuantityChance')) * doubling) * (1 + 2 * clamp01(stat('ShatterChance')));
      } else if (a.kind !== 'Thieving') q *= doubling;
      if (x.loot) q *= lootMult;
      if (x.completion) q /= stagesE;
      addOut(x.id, q * success);
    }
    for (const x of a.perHit || []) addOut(x.id, (x.qty + stat('FlatOnHitItemChance', x.id)) * (1 + stat('PercentOnHitItemChance', x.id)) * doubling * (a._hits ?? 1));

    const out = [...outQty].map(([id, q]) => ({ id, name: name(id), perHour: q * perHour, value: q * perHour * price(id) }))
      .sort((p, q) => q.value - p.value);
    const keep = 1 - clamp01(stat('PreservationChance'));
    const inp = a.inputs.map(x => {
      const ph = x.qty * keep * perHour, have = bank[x.id] ?? 0;
      return { id: x.id, name: name(x.id), perHour: ph, value: ph * price(x.id), have, hoursLeft: ph > 0 ? have / ph : Infinity };
    });
    const sales = out.reduce((s, x) => s + x.value, 0) + cash * perHour;
    const inputValue = inp.reduce((s, x) => s + x.value, 0);
    const goldCost = (a.goldCost || 0) * perHour;
    const gpPerHour = sales - goldCost - (countInputs ? inputValue : 0);
    const stockHours = inp.length ? Math.min(...inp.map(x => x.hoursLeft)) : Infinity;
    const runHours = Math.min(hours, stockHours);
    results.push({
      id: a.id, skill: a.skill, name: a.name, area: a.area, unlocked: missing.length === 0, missing, notes,
      seconds, success, gpPerHour, sales, inputValue, cashPerHour: cash * perHour,
      xpPerHour: (a.xp + stat('FlatXPGained')) / stagesE * success * perHour * (1 + stat('PercentXPGained')) * (a.kind === 'Mining' ? 1 + clamp01(stat('ShatterChance')) : 1),
      outputs: out, inputs: inp, stockHours, runHours, totalForHours: gpPerHour * runHours,
      gear: [...new Set(rows.filter(r => !/:| mastery$/.test(r.from)).map(r => name(r.from)))],
      account: [...new Set(rows.filter(r => /:| mastery$/.test(r.from)).map(r => r.from))],
    });
  }
  return results;
}

// Farming plots and ranching pens from the save, as gold/hr while they run alongside an active skill.
// Farming assumes you replant and harvest on time (manual or automated); ranching uses each animal's
// saved hunger, safety and satisfaction.
const dn = n => typeof n === 'string' ? n : n?.Singular || n?.Plural || '';
function evaluatePassive(catalog, { levels, bank, toolbelts = {}, acct = null, farming = [], ranching = [], hours = 8 }) {
  const { items, passive: P } = catalog;
  const price = id => items[id]?.price ?? 0;
  const name = id => items[id]?.name ?? id;
  const ac = accountRows(acct);
  const out = [];
  const farmRow = (plot, recipeId, compostId, watered, auto) => {
    const r = P.farmRecipes.get(recipeId);
    if (!r) return null;
    const cat = P.farmCats.get(local(r.Category));
    const a = { skill: 'Farming', ctx: { recipe: recipeId, category: local(r.Category), plot } };
    const { stat: s0, rows } = statFor(a, toolbelts, items, ac.rows);
    const extra = [...(compostId && cat?.CanCompost && r.CanCompost !== false ? P.compost.get(compostId) || [] : []), ...(watered && cat?.CanWater ? cat.WateringModifierTemplate || [] : [])].map(b => modRow(b, b.Value));
    const stat = (n, item) => s0(n, item) + extra.filter(x => x.stat === n && (!x.item || x.item === item)).reduce((v, x) => v + x.value, 0) + (n === 'PercentXPGained' ? ac.xp : 0);
    const grow = Math.floor((r.BaseInterval + stat('FlatInterval')) * (1 + stat('PercentInterval')));
    const regrows = Math.max(0, (r.Regrows || 0) + stat('FlatRegrows'));
    const regrowMs = Math.floor(((r.RegrowInterval || 0) + stat('FlatInterval')) * (1 + stat('PercentInterval')));
    const dis = cat?.AttractsDisease ? (r.DiseaseValueAdjuster || 0) + (cat.DiseaseValueAdjuster || 0) : 0;
    const pest = cat?.AttractsPests ? (r.PestValueAdjuster || 0) + (cat.PestValueAdjuster || 0) : 0;
    const adj = 1 - (Math.max(0, pest - stat('FlatPestProtection')) + Math.max(0, dis - stat('FlatDiseaseProtection'))) / 100;
    const pid = local(r.Product?.Item);
    if (!pid) return null;
    const qty = Math.max(1, Math.floor((r.Product.Quantity + stat('FlatProductQuantity', pid)) * (1 + stat('PercentProductQuantity', pid)) * adj)) * (1 + clamp01(stat('DoublingChance')));
    const harvests = 1 + regrows;
    const hours = (grow + regrows * regrowMs) / 3.6e6;
    const keep = 1 - clamp01(stat('PreservationChance'));
    const seeds = (r.Ingredients?.Items || []).map(x => ({ id: local(x.Item), qty: Math.max(1, Math.floor(x.Quantity * (1 + stat('PercentIngredientCost')))) * keep }));
    const inputs = [...seeds, ...(compostId ? [{ id: compostId, qty: 1 }] : [])];
    // Each automated action pays the automation cost: plant, compost and water once per planting, harvest per harvest.
    if (auto) {
      const acts = (auto.plant ? 1 : 0) + (auto.compost && compostId ? 1 : 0) + (auto.water && cat?.CanWater ? 1 : 0) + (auto.harvest ? harvests : 0);
      for (const x of r.AutomationCosts?.Items || []) inputs.push({ id: local(x.Item), qty: Math.max(0, Math.ceil((x.Quantity + stat('FlatAutomationCost')) * (1 + stat('PercentAutomationCost')))) * acts });
    }
    const sales = harvests * qty * price(pid);
    const cost = inputs.reduce((v, x) => v + x.qty * price(x.id), 0);
    const lvl = (r.Requirements || []).find(q => /Level/.test(q.Type))?.Data?.Level || 1;
    return {
      recipe: recipeId, name: r.DisplayName, product: name(pid), hours, harvests, qtyPerHarvest: qty, adj,
      gpPerHour: (sales - cost) / hours, sales: sales / hours, cost: cost / hours,
      xpPerHour: harvests * (r.BaseExperience + stat('FlatXPGained')) * (1 + stat('PercentXPGained')) / hours,
      outputs: [{ id: pid, name: name(pid), perHour: harvests * qty / hours, value: sales / hours }],
      inputs: inputs.map(x => ({ id: x.id, name: name(x.id), perHour: x.qty / hours, value: x.qty * price(x.id) / hours, have: bank[x.id] ?? 0, hoursLeft: x.qty > 0 ? (bank[x.id] ?? 0) / (x.qty / hours) : Infinity })),
      unlocked: (levels.Farming || 1) >= lvl, level: lvl, account: [...new Set(rows.map(x => x.from).filter(f => /:| mastery$/.test(f)))],
    };
  };
  for (const p of farming) {
    if (!p.bought) continue;
    const plotDef = P.plots.get(p.plot);
    const recipeId = p.ids.find(id => P.farmRecipes.has(id));
    const compostId = p.ids.find(id => P.compost.has(id)) || null;
    const autoAll = p.auto.plant && p.auto.harvest ? p.auto : null;
    const cur = recipeId ? farmRow(p.plot, recipeId, compostId, p.watered || p.auto.water, autoAll) : null;
    // Best alternative in the same category you can grow now.
    const catId = local(plotDef?.Category);
    let best = null;
    for (const [rid, r] of P.farmRecipes) {
      if (local(r.Category) !== catId || !P.farmIncluded.has(r.Id)) continue;
      const x = farmRow(p.plot, rid, compostId, p.watered || p.auto.water, autoAll);
      if (x && x.unlocked && (!best || x.gpPerHour > best.gpPerHour)) best = x;
    }
    const row = cur || best;
    if (!row) continue;
    const notes = [];
    if (!cur) notes.push('empty plot');
    if (best && cur && best.recipe !== cur.recipe && best.gpPerHour > cur.gpPerHour * 1.05) notes.push(`better: ${dn(best.name)} ${Math.round(best.gpPerHour).toLocaleString()}/hr`);
    if (row.adj < 1) notes.push(`${Math.round((1 - row.adj) * 100)}% lost to pests/disease`);
    notes.push(autoAll ? 'automated' : 'replant by hand', `${row.hours < 1 ? Math.round(row.hours * 60) + ' min' : row.hours.toFixed(1) + ' h'} per planting`);
    const stock = row.inputs.length ? Math.min(...row.inputs.map(x => x.hoursLeft)) : Infinity;
    out.push({
      id: 'Farming:' + p.plot, skill: 'Farming', passive: true, name: `${(dn(plotDef?.DisplayName) || p.plot).replace(/\s+/g, ' ')}: ${dn(row.name)}`, area: P.farmCats.get(catId)?.DisplayName || catId,
      unlocked: true, missing: [], notes, seconds: row.hours * 3600 / row.harvests, success: row.adj, unit: 'harvest',
      gpPerHour: row.gpPerHour, sales: row.sales, inputValue: row.cost, cashPerHour: 0, xpPerHour: row.xpPerHour,
      outputs: row.outputs, inputs: row.inputs, stockHours: stock, runHours: Math.min(hours, stock), totalForHours: row.gpPerHour * Math.min(hours, stock), gear: [], account: row.account,
    });
  }
  for (const e of ranching) {
    const groups = new Map();
    for (const an of e.animals) { const g = groups.get(an.animal) || []; g.push(an); groups.set(an.animal, g); }
    for (const [aid, list] of groups) {
      const def = P.animals.get(aid);
      if (!def) continue;
      const a = { skill: 'Ranching', ctx: { animal: aid } };
      const { stat: s0, rows } = statFor(a, toolbelts, items, ac.rows);
      const stat = (n, item) => s0(n, item) + (n === 'PercentXPGained' ? ac.xp : 0);
      const prodH = Math.floor((def.ProductInterval + stat('FlatProductInterval')) * (1 + stat('PercentProductInterval'))) / 3.6e6;
      const lifeH = Math.floor((def.LifespanInterval + stat('FlatLifespanInterval')) * (1 + stat('PercentLifespanInterval'))) / 3.6e6;
      // Happiness from each animal's saved hunger, safety and satisfaction (ActiveRanchingAnimal.UpdateHappiness).
      const happy = list.map(x => (x.hunger > 0 && x.safety > 0) ? Math.max(0, x.hunger * 0.3 + (x.safety >= 0.75 ? 1 : x.safety) * 0.3 + x.satisfaction * 0.4 - (x.sick ? 0.3 : 0) + stat('FlatHappiness')) : 0);
      const H = happy.reduce((v, x) => v + x, 0); // sum over animals
      const dbl = 1 + clamp01(stat('DoublingChance'));
      const outputs = (def.Products || []).map(pr => { const id = local(pr.Item); const q = Math.max(0, (pr.Quantity + stat('FlatProductQuantity', id)) * (1 + stat('PercentProductQuantity', id))) * H * dbl / prodH; return { id, name: name(id), perHour: q, value: q * price(id) }; });
      const n = list.length;
      const eats = (def.Eats || []).map(x => ({ id: local(x.Item), qty: Math.max(1, Math.floor((x.Quantity + stat('FlatEatsQuantity')) * (1 + stat('PercentEatsQuantity')))) * (1 - clamp01(stat('FoodPreservationChance'))) * n }));
      const treats = (def.Treats || []).filter(t => (bank[local(t.Item)] ?? 0) > 0).map(t => ({ id: local(t.Item), qty: t.Quantity * n / 24 }));
      const buy = (def.PurchaseCosts?.Currencies || []).filter(c => c.Currency === GOLD).reduce((v, c) => v + c.Quantity, 0) * n / lifeH;
      const inputs = [...eats, ...treats].map(x => ({ id: x.id, name: name(x.id), perHour: x.qty, value: x.qty * price(x.id), have: bank[x.id] ?? 0, hoursLeft: x.qty > 0 ? (bank[x.id] ?? 0) / x.qty : Infinity }));
      const sales = outputs.reduce((v, x) => v + x.value, 0);
      const cost = inputs.reduce((v, x) => v + x.value, 0) + buy;
      const avgHappy = H / n;
      const notes = [`${n} animals`, `happiness ${Math.round(avgHappy * 100)}%`, `replacement ${Math.round(buy).toLocaleString()} gold/hr (lives ${Math.round(lifeH)} h)`];
      if (list.some(x => x.safety < 0.75)) notes.push('enclosure needs maintenance');
      const stock = inputs.length ? Math.min(...inputs.map(x => x.hoursLeft)) : Infinity;
      out.push({
        id: `Ranching:${e.enclosure}:${aid}`, skill: 'Ranching', passive: true, name: `${dn(def.DisplayName)} x${n}`, area: e.enclosure.replace(/([a-z])([A-Z])/g, '$1 $2'),
        unlocked: true, missing: [], notes, seconds: prodH * 3600, success: avgHappy, unit: 'product cycle',
        gpPerHour: sales - cost, sales, inputValue: cost, cashPerHour: 0,
        xpPerHour: (def.BaseExperience + stat('FlatXPGained')) * (1 + stat('PercentXPGained')) * H / prodH,
        outputs: outputs.sort((x, y) => y.value - x.value), inputs, stockHours: stock, runHours: Math.min(hours, stock), totalForHours: (sales - cost) * Math.min(hours, stock), gear: [], account: [...new Set(rows.map(x => x.from).filter(f => /:| mastery$/.test(f)))],
      });
    }
  }
  return out;
}

module.exports = { buildCatalog, evaluate, evaluatePassive, accountRows, statFor, woodHits, miningHits, expectedSteps };
