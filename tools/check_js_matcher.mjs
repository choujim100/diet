// Check that web/js/matcher.js gives the same answers as tools/match_foods.py.
//   python tools/dump_py_matches.py > <file>   (writes expected results)
//   node tools/check_js_matcher.mjs <file>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Matcher } from '../web/js/matcher.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const foods = JSON.parse(readFileSync(join(root, 'web/data/foods.json'), 'utf8'));
const aliases = JSON.parse(readFileSync(join(root, 'web/data/aliases.json'), 'utf8'));
const m = new Matcher(foods, aliases);
const expected = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let same = 0;
const diffs = [];
for (const e of expected) {
  const r = m.match(e.query);
  const got = r.match ? { number: r.match.number, confidence: r.match.confidence } : null;
  const ok = JSON.stringify(got) === JSON.stringify(e.match);
  if (ok) same++; else diffs.push({ query: e.query, py: e.match, js: got });
}
console.log(`${same}/${expected.length} identical to Python`);
for (const d of diffs.slice(0, 25)) console.log(JSON.stringify(d));
process.exit(diffs.length ? 1 : 0);
