// Match a Swedish retail product name to a Livsmedelsverket food.
// Port of tools/match_foods.py: keep the two in step (tools/check_js_matcher.mjs compares them).
// Layers: alias table (data/aliases.csv) -> fuzzy match over all foods -> none.

const NOISE = new Set(`svensk svenska sverige ekologisk ekologiska eko krav frigaende farsk farska fryst frysta frysvara
djupfryst kyld klass extra stor store liten premium original classic pack forpackning
lidl milbona pilos dulano freshona culinea chef select vemondo kania eridanous deluxe bonduelle
nixe favorina cien sondey`.split(/\s+/).filter(Boolean));
const DISH = new Set(`soppa gratang sas pizza paj kaka bulle gryta pudding smorgas sandwich wrap pastej mousse glass kex
bakelse tarta pannkakor plattar bullar dessert drink lask lasagne`.split(/\s+/).filter(Boolean));
const NONFOOD = new Set(`diskmedel disktabletter tvattmedel tvattmedel skoljmedel schampo balsam tval tandkram
tandborste toalettpapper hushallspapper batteri batterier blojor hundmat kattmat djurmat rengoring
sopsackar sopsack deodorant rakhyvel rakskum plastpase folie bakplatspapper glodlampa lampa
ljus tidning leksak verktyg skruv troja byxor strumpor handskar sangklader handduk kudde filt
stekpanna vattenflaska parasoll tvattlappar vattpinnar bindor tamponger plastfickor`.split(/\s+/).filter(Boolean));
const SUFFIXES = ['er', 'ar', 'n', 'en', 'et', 'or', 'na', 'ter'];
const STEM_ENDINGS = ['arna', 'orna', 'erna', 'ar', 'or', 'er', 'na', 'n', 'a', 'e', 't'];
const SHORT_HEADS = new Set(['brod', 'olja', 'kaka', 'korv', 'ost', 'deg', 'sas', 'gryn', 'saft', 'paj', 'file']);
const HEADS = new Set([...SHORT_HEADS, 'soppa', 'glass', 'kakor', 'sylt', 'juice', 'pizza', 'grot', 'smor']);
const FAT_RE = /(\d+(?:[.,]\d+)?)\s*%/;
const FAT_RE_G = /(\d+(?:[.,]\d+)?)\s*%/g;
const QTY_RE = /\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|ml|cl|dl|l|st|pack|-pack|knippe|kruka)\b|\b\d+-pack\b|\bx\d+\b/g;

export function norm(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
function parseFat(s) {
  const m = FAT_RE.exec(s);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}
export function cleanQuery(raw) {
  let s = norm(raw);
  const fat = parseFat(s);
  s = s.replace(FAT_RE_G, ' ').replace(QTY_RE, ' ').replace(/[^a-z0-9 ]/g, ' ');
  const toks = s.split(/\s+/).filter((t) => t && !/^\d+$/.test(t) && !NOISE.has(t));
  return { toks, fat };
}
function stem(t) {
  for (const e of STEM_ENDINGS) if (t.endsWith(e) && t.length - e.length >= 3) return t.slice(0, -e.length);
  return t;
}
function isNonfood(toks) {
  for (const t of toks) for (const w of NONFOOD) {
    if ((w.length >= 7 && t.includes(w)) || t === w || (w.length < 7 && t.endsWith(w))) return true;
  }
  return false;
}
function trigrams(s) {
  s = `  ${s} `;
  const out = new Set();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}
function dice(a, b) {
  const ta = trigrams(a), tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}
// Ratcliff/Obershelp ratio, like Python's difflib.SequenceMatcher(None, a, b).ratio()
function seqRatio(a, b) {
  function longest(alo, ahi, blo, bhi) {
    let bi = alo, bj = blo, bk = 0;
    for (let i = alo; i < ahi; i++) for (let j = blo; j < bhi; j++) {
      let k = 0;
      while (i + k < ahi && j + k < bhi && a[i + k] === b[j + k]) k++;
      if (k > bk) { bi = i; bj = j; bk = k; }
    }
    return [bi, bj, bk];
  }
  function matches(alo, ahi, blo, bhi) {
    if (alo >= ahi || blo >= bhi) return 0;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) return 0;
    return k + matches(alo, i, blo, j) + matches(i + k, ahi, j + k, bhi);
  }
  const t = a.length + b.length;
  return t ? (2 * matches(0, a.length, 0, b.length)) / t : 1;
}
function credit(q, f) {
  if (q === f) return q.length;
  if (q.length >= 5 && f.length >= 5) {
    if (stem(q) === stem(f)) return q.length;
    if (seqRatio(q, f) >= 0.88) return q.length;
  }
  if (q.length > f.length && q.length - f.length >= 3) {
    if (q.endsWith(f) && (f.length >= 5 || SHORT_HEADS.has(f))) return f.length;
    if (q.startsWith(f) && f.length >= 5) return f.length;
  }
  if (q.length > f.length && q.startsWith(f) && f.length >= 5 && SUFFIXES.includes(q.slice(f.length))) return q.length;
  if (f.length > q.length && q.length >= 5 && f.endsWith(q) && f.length - q.length >= 3) return q.length;
  return 0;
}
function creditWord(q, ftoks) {
  let sum = 0;
  for (const f of ftoks) { const c = credit(q, f); if (c) sum += c; }
  return Math.min(q.length, sum);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Matcher {
  constructor(foodsData, aliasesData) {
    this.keys = foodsData.keys;
    this.keyIx = Object.fromEntries(this.keys.map((k, i) => [k, i]));
    this.foods = new Map();
    this.byCurated = new Map();
    this.index = [];
    for (const row of foodsData.foods) {
      const f = { number: row[0], name: row[1], name_sv: row[2], curated_id: row[3], type: row[4] === 'A' ? 'Analysed' : 'Calculated', vals: row[5] };
      this.foods.set(f.number, f);
      if (f.curated_id) this.byCurated.set(f.curated_id, f);
      const name = norm(f.name_sv || f.name).replace(/[^a-z0-9 ]/g, ' ').replace(FAT_RE_G, ' ');
      this.index.push({ number: f.number, name, ftoks: new Set(name.split(/\s+/).filter(Boolean)) });
    }
    this.aliases = [];
    const suf = `(?:${SUFFIXES.join('|')})?`;
    for (const row of aliasesData) {
      for (const a0 of row.aliases) {
        const a = norm(a0.trim());
        const rx = new RegExp((a.length >= 5 ? '' : '\\b') + escapeRe(a) + suf + '\\b');
        this.aliases.push({ rx, len: a.length, targets: row.targets, canned: row.canned, frozen: row.frozen, alias: a });
      }
    }
    this.aliases.sort((x, y) => y.len - x.len);
  }
  nut(food, key) { return food.vals[this.keyIx[key]]; }
  food(target) {
    let f = this.byCurated.get(target);
    if (!f && target.startsWith('n:')) f = this.foods.get(parseInt(target.slice(2), 10));
    if (!f) throw new Error('alias target not found: ' + target);
    return f;
  }
  pack(f, via, confidence, note = null, score = null) {
    return { number: f.number, curated_id: f.curated_id, name_sv: f.name_sv, name: f.name, type: f.type, via, confidence, score, note };
  }
  match(raw, top = 3) {
    const { toks, fat } = cleanQuery(raw);
    if (isNonfood(toks)) return { query: raw, match: null, candidates: [], note: 'non-food' };
    const text = toks.join(' ');
    const whole = norm(raw);
    const canned = /\b(burk|konserv\w*|tetra)\b/.test(whole);
    const frozen = /\b(fryst|frysta|frysvara|djupfryst)\b/.test(whole);
    const light = /\blatt\b/.test(whole);
    // 1. alias: earliest start wins, ties go to the longer alias
    const hits = [];
    for (const e of this.aliases) { const mo = e.rx.exec(text); if (mo) hits.push({ start: mo.index, len: e.len, e }); }
    hits.sort((x, y) => x.start - y.start || y.len - x.len);
    if (hits.length) {
      const e = hits[0].e;
      let targets = e.targets;
      if (canned && e.canned.length) targets = e.canned; else if (frozen && e.frozen.length) targets = e.frozen;
      const foods = targets.map((t) => this.food(t));
      if (foods.length === 1) return { query: raw, match: this.pack(foods[0], `alias:${e.alias}`, 'high'), candidates: [] };
      const fatval = (f) => this.nut(f, 'fat_g');
      if (fat !== null) {
        let best = foods[0];
        for (const f of foods) if (Math.abs(fatval(f) - fat) < Math.abs(fatval(best) - fat)) best = f;
        const gap = Math.abs(fatval(best) - fat);
        const [conf, note] = gap <= 1 ? ['high', null] : ['medium', `nearest variant is ${+fatval(best).toPrecision(6)}% fat, label says ${fat}%`];
        return { query: raw, match: this.pack(best, `alias:${e.alias}+fat`, conf, note), candidates: [] };
      }
      if (light) {
        let best = foods[0];
        for (const f of foods) if (fatval(f) < fatval(best)) best = f;
        return { query: raw, match: this.pack(best, `alias:${e.alias}+light`, 'medium'), candidates: [] };
      }
      const alts = foods.slice(1).map((f) => this.pack(f, `alias:${e.alias}`, 'low'));
      return { query: raw, match: this.pack(foods[0], `alias:${e.alias}`, 'low', 'several variants; fat % not given'), candidates: alts };
    }
    // 2. fuzzy
    if (!toks.length) return { query: raw, match: null, candidates: [] };
    let longest = toks[0];
    for (const t of toks) if (t.length > longest.length) longest = t;
    const heads = new Set();
    for (const q of toks) for (const h of HEADS) if (q.endsWith(h) && q.length > h.length) heads.add(h);
    const total = toks.reduce((s, q) => s + q.length, 0);
    const scored = [];
    for (const { number, name, ftoks } of this.index) {
      if (heads.size) {
        let ok = true;
        for (const h of heads) {
          let any = false;
          for (const f of ftoks) if (f.endsWith(h) || stem(f) === stem(h)) { any = true; break; }
          if (!any) { ok = false; break; }
        }
        if (!ok) continue;
      }
      const credits = new Map();
      for (const q of toks) credits.set(q, creditWord(q, ftoks));
      if (credits.get(longest) === 0) continue;
      let cs = 0;
      for (const v of credits.values()) cs += v;
      const coverage = cs / total;
      if (coverage < 0.3) continue;
      const f = this.foods.get(number);
      let score = 0.6 * coverage + 0.4 * dice(text, name);
      let dish = false;
      for (const t of ftoks) if (DISH.has(t)) { dish = true; break; }
      if (dish) score -= 0.15;
      if (` ${name} `.includes(' m ') || ` ${name} `.includes(' med ')) score -= 0.05;
      if (f.curated_id) score += 0.08;
      if (f.type === 'Analysed') score += 0.03;
      const ff = this.nut(f, 'fat_g');
      if (fat !== null && ff !== null && ff !== undefined) score += Math.abs(ff - fat) <= 1 ? 0.05 : -0.02;
      scored.push([score, number]);
    }
    scored.sort((x, y) => y[0] - x[0] || y[1] - x[1]);
    if (!scored.length || scored[0][0] < 0.5) return { query: raw, match: null, candidates: [] };
    const cands = scored.slice(0, top).map(([s, n]) => this.pack(this.foods.get(n), 'fuzzy', 'low', null, Math.round(s * 1000) / 1000));
    const best = cands[0];
    if (best.score >= 0.9 && (cands.length === 1 || cands[1].score < best.score - 0.05)) best.confidence = 'medium';
    return { query: raw, match: best, candidates: cands.slice(1) };
  }
}
