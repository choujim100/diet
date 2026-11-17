// "Scan nutrition label" block for the product window: photo -> OCR -> side-by-side comparison with the
// values on record. The user decides, row by row, whether the label value replaces the recorded one.
// The reader never settles a doubt on its own: every row it could not read, or could not settle, is shown with a
// warning, and so is every line with an amount that it could not place.
import { h, clear, toast } from './ui.js';
import { NUTRIENT_INFO } from './nutrition.js';
import { readLabelTexts, parseLabels, compareLabel } from './label.js';

// rows that the law requires on every label (fibre is optional but common), so a missing one is a read failure
const EXPECTED = ['energy_kcal', 'fat_g', 'saturated_fat_g', 'carbs_g', 'sugars_g', 'fibre_g', 'protein_g', 'salt_g'];

/**
 * getPer100(): current per-100 g values. apply(key, value): set one value in the product window.
 * Returns a DOM element.
 */
export function labelScanner({ getPer100, apply }) {
  const out = h('div', { class: 'stack' });
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) run(f); } });
  const btn = h('button', { onclick: () => file.click() }, 'Scan nutrition label');

  async function run(f) {
    clear(out);
    const status = h('p', { class: 'muted' }, 'Preparing…');
    out.append(status);
    btn.disabled = true;
    try {
      const texts = await readLabelTexts(f, (msg, p) => { status.textContent = p ? `${msg} ${Math.round(p * 100)}%` : msg; });
      show(f, texts);
    } catch (e) {
      console.error(e);
      clear(out);
      out.append(h('div', { class: 'banner bad' }, `Could not read the label: ${e.message || e}. You can still type the values.`));
    } finally { btn.disabled = false; }
  }

  function show(f, texts) {
    clear(out);
    const parsed = parseLabels(texts);
    if (texts.columns > 1) parsed.columns = true;
    const rows = compareLabel(getPer100(), parsed, { expected: EXPECTED });
    const url = URL.createObjectURL(f);
    const picture = h('img', { src: url, alt: 'Your label photo', style: 'max-width:100%;max-height:220px;border-radius:8px;border:1px solid var(--line)', onload: () => URL.revokeObjectURL(url) });
    const raw = h('details', null, h('summary', { class: 'muted' }, 'Text the reader saw'), (texts.raw || texts).map((t, i) => h('pre', { style: 'white-space:pre-wrap;font-size:.8rem;max-height:200px;overflow:auto' }, `Pass ${i + 1}:
${t.trim() || '(nothing)'}`)));
    const found = rows.filter((r) => r.status !== 'missing');
    if (!found.length) {
      out.append(picture, h('div', { class: 'banner bad' }, 'Nothing could be read from this photo, so nothing is changed. Hold the phone straight above the table, in good light, and fill the frame with it. Or type the values.'), raw);
      return;
    }
    const name = (k) => NUTRIENT_INFO[k].label.toLowerCase();
    const missing = rows.filter((r) => r.status === 'missing');
    const unsure = rows.filter((r) => r.status !== 'missing' && r.uncertain);
    const repaired = rows.filter((r) => r.status !== 'missing' && !r.uncertain && r.adjusted);
    const left = (parsed.left || []).filter((l) => !l.known);
    const skipped = (parsed.left || []).filter((l) => l.known);

    const choice = {}; // key -> true when the label value should be used
    const picks = {};
    const clean = (r) => r.status !== 'missing' && !r.uncertain && !r.adjusted;
    const body = rows.map((r) => {
      const info = NUTRIENT_INFO[r.key];
      choice[r.key] = r.status === 'new' && clean(r); // only clean, undisputed new values default to "use label"
      const recorded = h('td', { class: 'num' }, r.db === undefined || r.db === null ? h('span', { class: 'muted' }, 'not listed') : `${r.db} ${info.unit}`);
      if (r.status === 'missing') {
        return h('tr', { style: 'background:var(--near-bg)' }, h('td', null, info.label), recorded,
          h('td', { class: 'num' }, h('span', { class: 'status low' }, 'not read')),
          h('td', null, h('span', { class: 'chip warn' }, '⚠ not read'), r.key === 'fibre_g' ? ' Fibre is optional on labels, so it may simply not be printed. Nothing is changed.' : ' Check the package; nothing is changed for this row.'));
      }
      const sel = h('select', { 'aria-label': `${info.label}: which value to use`, onchange: (e) => { choice[r.key] = e.target.value === 'label'; } },
        r.status === 'same' ? h('option', { value: 'keep' }, 'Keep (same)') : [h('option', { value: 'keep', selected: !choice[r.key] }, 'Keep recorded'), h('option', { value: 'label', selected: choice[r.key] }, 'Use label')]);
      if (r.status === 'same') sel.disabled = true;
      picks[r.key] = sel;
      const alts = r.uncertain && r.alts.length ? h('div', { class: 'muted', style: 'font-size:.8rem' }, `could also be ${r.alts.join(' or ')}`) : null;
      return h('tr', { style: r.status === 'differs' || r.uncertain ? 'background:var(--near-bg)' : null },
        h('td', null, info.label),
        recorded,
        h('td', { class: 'num' }, `${r.lt ? '< ' : ''}${r.label} ${info.unit}`, alts),
        h('td', null, r.status === 'same' ? h('span', { class: 'status ok' }, '✓ same') : r.status === 'new' ? h('span', { class: 'status near' }, 'new') : h('span', { class: 'status low' }, '⚠ differs'),
          r.uncertain ? h('span', { class: 'chip warn', title: 'The reader could not settle this number; check it on the package' }, '⚠ unsure') : r.adjusted ? h('span', { class: 'chip warn', title: 'The reader dropped a comma or unit; the number was repaired so the label adds up. Check it on the package' }, '⚠ repaired') : null, ' ', sel));
    });
    const differs = rows.filter((r) => r.status === 'differs').length;
    const news = rows.filter((r) => r.status === 'new').length;
    const useAll = () => { for (const r of rows) if (r.status !== 'same' && clean(r)) { choice[r.key] = true; picks[r.key].value = 'label'; } };
    const applyChoices = () => {
      let n = 0;
      for (const r of rows) if (r.status !== 'same' && r.status !== 'missing' && choice[r.key]) { apply(r.key, r.label); n++; }
      toast(n ? `${n} value${n === 1 ? '' : 's'} updated from the label.` : 'No values changed.');
      clear(out);
    };
    const attention = [...missing.map((r) => `${name(r.key)} (not read)`), ...unsure.map((r) => `${name(r.key)} (unsure)`), ...repaired.map((r) => `${name(r.key)} (repaired)`)];
    out.append(...[h('div', { class: 'row' }, picture),
      attention.length || left.length
        ? h('div', { class: 'banner bad' }, h('strong', null, `${attention.length + left.length} thing${attention.length + left.length === 1 ? '' : 's'} on this label could not be read with certainty. `),
          attention.length ? `Check these on the package: ${attention.join(', ')}. ` : '', left.length ? `${left.length} line${left.length === 1 ? '' : 's'} with an amount could not be matched to a nutrient (listed below).` : '')
        : h('div', { class: `banner ${differs ? 'warn' : 'good'}` }, differs
          ? `${differs} value${differs === 1 ? ' differs' : 's differ'} from the record. Compare with the package, then choose which to keep.`
          : 'Everything on the label was read and matches the record.'),
      attention.length && differs ? h('div', { class: 'banner warn' }, `${differs} value${differs === 1 ? ' differs' : 's differ'} from the record.`) : null,
      parsed.columns ? h('p', { class: 'muted', style: 'margin:0' }, 'This label has more than one column of numbers. Only the per 100 g column was used (the one under "100 g", otherwise the leftmost). A row whose per 100 g amount could not be read is marked "not read".') : null,
      h('p', { class: 'muted', style: 'margin:0' }, 'Nothing is applied until you choose it. Unsure and repaired values are never selected for you.'),
      h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', { class: 'num' }, 'Recorded'), h('th', { class: 'num' }, 'Label'), h('th', null, ''))), h('tbody', null, body))),
      left.length ? h('div', { class: 'banner warn' }, h('strong', null, 'Lines I could not place: '),
        'these carry an amount but did not match any nutrient I track. They may be vitamins or minerals, or a row the reader garbled. Nothing from them is used.',
        h('ul', { style: 'margin:.3rem 0 0 1rem;padding:0' }, left.map((l) => h('li', null, l.text)))) : null,
      skipped.length ? h('p', { class: 'muted', style: 'margin:0' }, `Left out on purpose (added sugars, mono- and polyunsaturated fat, polyols, starch, lactose): ${skipped.map((l) => l.text).join('; ')}`) : null,
      h('div', { class: 'row' }, differs + news ? h('button', { class: 'primary', onclick: applyChoices }, 'Apply my choices') : null,
        differs + news ? h('button', { onclick: () => { useAll(); } }, 'Select all clean label values') : null,
        h('button', { onclick: () => clear(out) }, 'Dismiss')),
      raw].filter(Boolean)); // DOM append() would print a null as the text "null"
  }

  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, btn, h('span', { class: 'muted' }, 'Photograph the nutrition table to check the numbers above.'), file), out);
}
