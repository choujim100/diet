// Read a photographed nutrition label: OCR in the browser (tesseract.js, bundled in vendor/), then turn the
// text into per-100 g values and compare them with the values already on record for the product.
// The photo never leaves the device.
//
// OCR drops decimal commas ("14,1 g" -> "141g") and reads "g" as "9" ("3,2 g" -> "3,29"). The parser keeps every
// plausible reading of a number and lets the label's own arithmetic choose: energy must fit 4*protein + 4*carbs + 9*fat,
// saturated fat cannot exceed fat, sugars cannot exceed carbohydrate, and several OCR passes should agree.
// Anything it had to adjust or could not settle is flagged for the user.

const KEYS = [
  // key, test on the text of a line (checked in this order, first match wins)
  // Swedish, Finnish and Danish (Nordic Lidl packs print all three on one row), plus English, German, Norwegian.
  // "omättat", "umættede", "unsaturated" and "ungesättigte" are the opposite of saturated, so they are excluded.
  ['saturated_fat_g', /(?<![ou])m[äaæ]ttat|(?<![ou])m[äaæ]ttade|(?<![ou])m(?:æ|ae|a|e)ttede|(?<!un)saturated|(?<!un)ges[äa]ttigt|(?<!u)mettet|tyydyttyneit|tyydyttynyt|tyydyttyv/],
  ['sugars_g', /socker|sugars?\b|zucker|soker[ei]|sukker/],
  ['fat_g', /\bfett\b|\bfat\b|\bfett\s*[:,]|\brasva|\bfedt\b/],
  ['carbs_g', /kolhydrat|carbohydrate|kohlenhydrat|hiilihydraat|kulhydrat|karbohydrat|kulhydrat/],
  ['fibre_g', /fiber|fibre|kostfib|ballaststoff|kuitu/],
  ['protein_g', /protein|eiwei|proteiini/],
  ['salt_g', /\bsalt\b|\bsalz\b|suola|\bsalt[:,]/],
];
// added sugar, mono- and polyunsaturated fat, polyols, starch, lactose: not the rows we want
const SKIP = /tillsatt|added|zugesetzt|lisätty|lisatty|tilsat|enkelomättat|enkeltumættede|fleromättat|flerumættede|monoomättat|mono|poly|laktos|lactose|stärkelse|stivelse|tärkkelys|starch|polyol|monityydyttym|kertatyydyttym|tyydyttym/;

const ENERGY = /energi|energy|energie|brennwert|energia|energ[ií]a/;
const toNum = (s) => parseFloat(String(s).replace(',', '.'));
// OCR often reads a 0 as O or o inside numbers, and decimal commas as dots or spaces
function clean(line) {
  return line.replace(/(?<=\d)[oO](?=[\d.,\s]|$)/g, '0').replace(/(?<=[\s(])[oO](?=[.,]\d)/g, '0').replace(/(\d)\s*[,.]\s*(\d)/g, '$1.$2').replace(/[|_]/g, ' ');
}

/** One OCR text -> raw readings per key: { cands: {key: [{value, lt, how}]}, columns, kj }. */
function readText(text) {
  const lines = text.split(/\r?\n/).map((l) => clean(l.toLowerCase()).trim()).filter(Boolean);
  const cands = {};
  let columns = false, kj = null, kcal = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ENERGY.test(line)) {
      const next = lines[i + 1] && !/[a-zåäöæø]{4,}/.test(lines[i + 1].replace(/k[ce]a[l1i]|kj/g, '')) ? lines[i + 1] : '';
      const KC = /(\d+(?:\.\d+)?)\s*k[ce]a[l1i]/; // "kcal", also as OCR often reads it: "keal", "kca1", "kcai"
      const k = KC.exec(line) || KC.exec(next);
      const j = /(\d+(?:\.\d+)?)\s*kj/.exec(line) || /^(\d+(?:\.\d+)?)\s*kj/.exec(next);
      if (j && kj === null) kj = toNum(j[1]);
      if (k && kcal === null) kcal = toNum(k[1]);
      if ((line.match(/k[ce]a[l1i]/g) || []).length > 1) columns = true;
      continue;
    }
    if (SKIP.test(line)) continue;
    for (const [key, re] of KEYS) {
      if (cands[key] || !re.test(line)) continue;
      let after = line.slice(line.search(re)).replace(re, ' ');
      // a long three-language row often wraps: the amount is then alone on the next line
      if (!/\d/.test(after) && lines[i + 1] && /\d/.test(lines[i + 1]) && [(KEYS.find(([, r2]) => r2.test(lines[i + 1])) || [key])[0]].includes(key) && !ENERGY.test(lines[i + 1]) && !SKIP.test(lines[i + 1])) after = lines[i + 1];
      const nums = [...after.matchAll(/(<\s*)?(\d+(?:\.\d+)?)\s*(g\b)?/g)];
      if (!nums.length) break;
      if (nums.length >= 2) columns = true;
      const m = nums[0];
      const lt = !!m[1];
      let raw = m[2];
      // "08" can only be 0,8: the decimal comma was lost after a leading zero
      const lead0 = /^0\d+$/.test(raw);
      if (lead0) raw = '0.' + raw.slice(1);
      const list = [];
      if (m[3]) list.push({ value: toNum(raw), lt, how: 'read' });                      // "32,1 g": unit seen, trust the number
      else {
        // no "g" after the number: the unit was lost or read as a digit ("3,29" for "3,2 g"; some fonts give 8)
        list.push({ value: toNum(raw), lt, how: 'read' });
        if (/[98]$/.test(raw) && raw.replace('.', '').length >= 2) list.push({ value: toNum(raw.slice(0, -1).replace(/\.$/, '')), lt, how: 'unit' });
      }
      if (lead0) for (const c of list) c.how = c.how === 'read' ? 'decimal' : 'unit+decimal';
      // "141" for "14,1": a lost decimal comma, so offer the value divided by 10 as well
      for (const c of [...list]) if (!String(c.value).includes('.') && c.value >= 10) {
        list.push({ value: c.value / 10, lt, how: c.how === 'read' ? 'decimal' : 'unit+decimal' });
        if (c.value >= 100) list.push({ value: c.value / 100, lt, how: c.how === 'read' ? 'decimal' : 'unit+decimal' });
      }
      cands[key] = list.filter((c) => Number.isFinite(c.value) && c.value >= 0);
      break;
    }
  }
  return { cands, columns, kj, kcal };
}

/**
 * Combine one or more OCR texts (passes over the same photo). Returns
 * { values: {key: {value, lt, adjusted, uncertain}}, columns, energy_kj }.
 */
export function parseLabels(texts) {
  const reads = texts.map(readText);
  const columns = reads.some((r) => r.columns);
  const kj = reads.map((r) => r.kj).find((x) => x != null) ?? null;
  const kcals = reads.map((r) => r.kcal).filter((x) => x != null);
  const energy = kcals.length ? kcals[0] : kj != null ? Math.round(kj / 4.184) : null; // labels print whole kcal
  const values = {};
  if (energy != null) values.energy_kcal = { value: energy, lt: false, adjusted: false, uncertain: false, fromKj: !kcals.length };

  // pool the readings of all passes: value -> how many (pass, reading) pairs give it
  const pool = {};
  for (const r of reads) for (const [key, list] of Object.entries(r.cands)) {
    const p = (pool[key] = pool[key] || new Map());
    for (const c of list) {
      const k = c.value;
      const e = p.get(k) || { value: c.value, lt: c.lt, n: 0, hows: new Set() };
      e.n += 1; e.hows.add(c.how); p.set(k, e);
    }
  }
  const options = (key) => [...(pool[key] ? pool[key].values() : [])]
    .filter((o) => o.value <= 100 && !(key === 'salt_g' && o.value > 30)); // a per-100 g amount in grams cannot exceed 100
  const adj = (o) => !o.hows.has('read');
  const decimals = (v) => (String(v).split('.')[1] || '').length;
  // how plausible one reading is, as a penalty (lower is better): agreement between passes helps; two decimals
  // (other than salt), and readings that needed a repair, count against it
  const penalty = (key, o) => (key === 'salt_g' ? 0 : decimals(o.value) > 1 ? 0.02 : 0) + (adj(o) ? 0.005 : 0) - 0.01 * o.n;
  const ranked = (key, opts) => opts.map((o) => ({ o, p: penalty(key, o) })).sort((a, b) => a.p - b.p || a.o.value - b.o.value);
  const best = (key, opts) => ranked(key, opts)[0].o;

  // fat, carbohydrate and protein together must give the energy
  const macro = ['fat_g', 'carbs_g', 'protein_g'];
  const chosen = {};
  let macroOk = false; // true when fat, carbohydrate and protein reproduce the energy on the label
  const macroOpts = macro.map(options);
  if (energy != null && macroOpts.every((o) => o.length)) {
    let top = null;
    for (const f of macroOpts[0]) for (const c of macroOpts[1]) for (const p of macroOpts[2]) {
      if (f.value + c.value + p.value > 101) continue;
      const err = Math.abs(energy - (9 * f.value + 4 * c.value + 4 * p.value)) / energy;
      const score = err + penalty('fat_g', f) + penalty('carbs_g', c) + penalty('protein_g', p);
      if (!top || score < top.score) top = { score, err, set: [f, c, p] };
    }
    if (top && top.err <= 0.1) { macro.forEach((k, i) => { chosen[k] = top.set[i]; }); macroOk = top.err <= 0.05; }
  }
  for (const [i, k] of macro.entries()) if (!chosen[k] && macroOpts[i].length) chosen[k] = best(k, macroOpts[i]);
  // parents first, then the "of which" rows that depend on them
  const dep = { saturated_fat_g: 'fat_g', sugars_g: 'carbs_g' };
  const fits = (key, o) => !dep[key] || !chosen[dep[key]] || o.value <= chosen[dep[key]].value + 0.05;
  for (const key of ['saturated_fat_g', 'sugars_g', 'fibre_g', 'salt_g']) {
    let opts = options(key).filter((o) => fits(key, o));
    if (!opts.length) opts = options(key);
    if (opts.length) chosen[key] = best(key, opts);
  }
  const macroAdj = macro.some((k) => chosen[k] && adj(chosen[k]));
  for (const [key, o] of Object.entries(chosen)) {
    const mine = penalty(key, o);
    const rivals = options(key).filter((x) => x.value !== o.value && fits(key, x));
    // macros are settled by the energy check; other rows are uncertain when another reading is nearly as plausible
    const close = !macro.includes(key) && rivals.some((x) => penalty(key, x) - mine < 0.015);
    // macros are trusted only when the energy check passed; the others need agreement or a clean reading
    // A repaired macro can be offset by a misread of another one (55.6 and 5.5 swapped give the same energy), so when
    // any macro was repaired, the macros that only one reading supports are doubtful as well.
    const doubtful = macro.includes(key) ? !macroOk || (macroAdj && !adj(o) && o.n < 2) : adj(o) && o.n < 2;
    values[key] = { value: o.value, lt: o.lt, adjusted: adj(o), uncertain: close || doubtful };
  }
  return { values, columns, energy_kj: kj };
}
export const parseLabel = (text) => parseLabels([text]);

// [absolute, relative]. Labels print one decimal (salt: two, sometimes one), so the absolute part is just the
// rounding step. It must stay far below the value itself: 0.13 g of salt against 0.03 g is a real difference.
const TOL = { energy_kcal: [3, 0.03], salt_g: [0.05, 0.1] };
const TOL_DEFAULT = [0.1, 0.03];
/** Compare label values with the per-100 g values on record. Statuses: same, differs, new (not on record). */
export function compareLabel(per100, label) {
  const rows = [];
  for (const [key, l] of Object.entries(label.values)) {
    const db = per100[key];
    let status;
    if (db === undefined || db === null) status = 'new';
    else {
      const [abs, rel] = TOL[key] || TOL_DEFAULT;
      const diff = Math.abs(db - l.value);
      status = diff <= Math.max(abs, rel * Math.max(db, l.value)) + 1e-9 || (l.lt && db <= l.value) ? 'same' : 'differs';
    }
    rows.push({ key, db, label: l.value, lt: l.lt, adjusted: l.adjusted, uncertain: l.uncertain, status });
  }
  return rows;
}

// ---------------- OCR (browser only) ----------------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the text reader.'));
    document.head.append(s);
  });
}

/** Scale to `width` px, grayscale and stretch the contrast (helps with glossy packaging). Returns a canvas. */
export async function prepareImage(file, width) {
  const bmp = await createImageBitmap(file);
  const scale = width / bmp.width;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = g; hist[g]++; }
  const total = c.width * c.height;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.02) { hi = i; break; } }
  const span = Math.max(40, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span)); d[i] = d[i + 1] = d[i + 2] = v; }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Rebuild the text of one OCR pass from word boxes, keeping only the "per 100 g" column.
 * Many labels print per 100 g next to per portion. When the reader misses the first number of a row, the plain
 * text then shows the per-portion amount alone, and the parser would take it for the per-100 g amount.
 * Here the numbers are grouped by horizontal position; a row whose number sits in another column is left without
 * an amount, so it is reported as "not found" rather than read wrongly.
 * lines: [{ words: [{ text, x0, x1 }] }]. Returns { text, columns } (columns: how many number columns were seen).
 */
export function wordsToText(lines) {
  const NUM = /^[<(]?\d[\d.,]*(?:g|9)?\)?$/;
  const rows = lines.map((l) => [...l.words].filter((w) => w.text && w.text.trim()).sort((a, b) => a.x0 - b.x0)).filter((r) => r.length);
  const plain = rows.map((r) => r.map((w) => w.text).join(' '));
  const lower = plain.map((t) => t.toLowerCase());
  const isEnergy = (t) => /energi|energy|energie|brennwert|kj|k[ce]a[l1i]/.test(t);
  const isKey = (i) => !isEnergy(lower[i]) && KEYS.some(([, re]) => re.test(lower[i])) && !SKIP.test(lower[i]);
  const hasNum = (i) => rows[i].some((w) => NUM.test(w.text));
  // a long row that wrapped: the first line holds the name, the line below it holds the amounts
  const isRow = (i) => isKey(i) || (i > 0 && isKey(i - 1) && !hasNum(i - 1) && hasNum(i) && !isEnergy(lower[i]) && !KEYS.some(([, re]) => re.test(lower[i])));
  // x-centres of the numbers on nutrient rows (the label words to their left are not numbers)
  const centres = [];
  rows.forEach((r, i) => { if (isRow(i)) for (const w of r) if (NUM.test(w.text)) centres.push((w.x0 + w.x1) / 2); });
  const pageW = Math.max(1, ...rows.flat().map((w) => w.x1));
  const gap = 0.08 * pageW;
  centres.sort((a, b) => a - b);
  const groups = [];
  for (const c of centres) { const g = groups[groups.length - 1]; if (g && c - g.max <= gap) { g.max = c; g.sum += c; g.n += 1; } else groups.push({ min: c, max: c, sum: c, n: 1 }); }
  const mean = groups.map((g) => g.sum / g.n);
  if (mean.length < 2) return { text: plain.join('\n'), columns: mean.length };
  // which column is "per 100 g": the one under a header word "100", otherwise the first from the left
  let want = 0;
  const firstRow = rows.findIndex((_, i) => isKey(i));
  const head = [];
  rows.slice(0, Math.max(0, firstRow)).forEach((r) => r.forEach((w) => { if (/^100(g|g:ssa|g:n)?$/i.test(w.text.replace(/[^\w:]/g, ''))) head.push((w.x0 + w.x1) / 2); }));
  if (head.length === 1) {
    const d = mean.map((m) => Math.abs(m - head[0]));
    const k = d.indexOf(Math.min(...d));
    if (d[k] < gap * 2) want = k;
  }
  const colOf = (w) => { const c = (w.x0 + w.x1) / 2; let k = 0; for (let j = 1; j < mean.length; j++) if (Math.abs(mean[j] - c) < Math.abs(mean[k] - c)) k = j; return k; };
  const out = rows.map((r, i) => {
    if (!isRow(i)) return plain[i];
    const firstNum = r.findIndex((w) => NUM.test(w.text));
    if (firstNum < 0) return plain[i];
    // label words stay; everything from the first number on (numbers and their units) belongs to a column
    return r.filter((w, j) => j < firstNum || colOf(w) === want).map((w) => w.text).join(' ');
  });
  return { text: out.join('\n'), columns: mean.length };
}

/** Read the text on a photo in two passes at different sizes. Resolves an array of texts. onProgress(text, fraction). */
export async function readLabelTexts(file, onProgress = () => {}) {
  const base = new URL('vendor/tesseract/', document.baseURI).href;
  onProgress('Loading the text reader (first time only, about 12 MB)…', 0);
  await loadScript(base + 'tesseract.min.js');
  const widths = [1800, 2700];
  let pass = 0;
  const worker = await window.Tesseract.createWorker(['swe', 'eng'], 1, {
    workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang', gzip: true,
    logger: (m) => { if (m.status === 'recognizing text') onProgress('Reading the label…', (pass + m.progress) / widths.length); },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const texts = [], raw = [];
    let columns = 0;
    for (; pass < widths.length; pass++) {
      const canvas = await prepareImage(file, widths[pass]);
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      raw.push(data.text);
      const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).map((l) => ({ words: l.words.map((w) => ({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1 })) }));
      if (lines.length) { const r = wordsToText(lines); texts.push(r.text); columns = Math.max(columns, r.columns); } else texts.push(data.text);
    }
    texts.raw = raw;       // the reader's own text, before the per-100 g column was picked
    texts.columns = columns; // number columns seen on the nutrient rows
    return texts;
  } finally {
    await worker.terminate();
  }
}
