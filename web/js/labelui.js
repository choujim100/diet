// "Scan nutrition label" block for the product window: photo -> OCR -> side-by-side comparison with the
// values on record. The user decides, row by row, whether the label value replaces the recorded one.
import { h, clear, toast } from './ui.js';
import { NUTRIENT_INFO } from './nutrition.js';
import { readLabelTexts, parseLabels, compareLabel } from './label.js';

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
    const rows = compareLabel(getPer100(), parsed);
    const url = URL.createObjectURL(f);
    const picture = h('img', { src: url, alt: 'Your label photo', style: 'max-width:100%;max-height:220px;border-radius:8px;border:1px solid var(--line)', onload: () => URL.revokeObjectURL(url) });
    const raw = h('details', null, h('summary', { class: 'muted' }, 'Text the reader saw'), texts.map((t, i) => h('pre', { style: 'white-space:pre-wrap;font-size:.8rem;max-height:200px;overflow:auto' }, `Pass ${i + 1}:
${t.trim() || '(nothing)'}`)));
    if (!rows.length) {
      out.append(picture, h('div', { class: 'banner warn' }, 'No nutrition values were found in this photo. Hold the phone straight above the table, in good light, and fill the frame with it. Or type the values.'), raw);
      return;
    }
    const choice = {}; // key -> true when the label value should be used
    const picks = {};
    const body = rows.map((r) => {
      const info = NUTRIENT_INFO[r.key];
      choice[r.key] = r.status === 'new' && !r.uncertain && !r.adjusted; // only clean, undisputed new values default to "use label"; differing, repaired or doubtful ones wait for the user
      const sel = h('select', { 'aria-label': `${info.label}: which value to use`, onchange: (e) => { choice[r.key] = e.target.value === 'label'; } },
        r.status === 'same' ? h('option', { value: 'keep' }, 'Keep (same)') : [h('option', { value: 'keep', selected: !choice[r.key] }, 'Keep recorded'), h('option', { value: 'label', selected: choice[r.key] }, 'Use label')]);
      if (r.status === 'same') sel.disabled = true;
      picks[r.key] = sel;
      return h('tr', { style: r.status === 'differs' ? 'background:var(--near-bg)' : null },
        h('td', null, info.label),
        h('td', { class: 'num' }, r.db === undefined ? h('span', { class: 'muted' }, 'not listed') : `${r.db} ${info.unit}`),
        h('td', { class: 'num' }, `${r.lt ? '< ' : ''}${r.label} ${info.unit}`),
        h('td', null, r.status === 'same' ? h('span', { class: 'status ok' }, '✓ same') : r.status === 'new' ? h('span', { class: 'status near' }, 'new') : h('span', { class: 'status low' }, '⚠ differs'),
          r.uncertain ? h('span', { class: 'chip warn', title: 'The reader could not decide between readings of this number, for example 2.1 or 21.9' }, 'check') : r.adjusted ? h('span', { class: 'chip plain', title: 'The reader dropped a comma or unit; the number was repaired so the label adds up' }, 'repaired') : null, ' ', sel));
    });
    const differs = rows.filter((r) => r.status === 'differs').length;
    const news = rows.filter((r) => r.status === 'new').length;
    const missing = ['energy_kcal', 'fat_g', 'saturated_fat_g', 'carbs_g', 'sugars_g', 'protein_g', 'salt_g'].filter((k) => !(k in parsed.values)).map((k) => NUTRIENT_INFO[k].label.toLowerCase());
    const useAll = () => { for (const r of rows) if (r.status !== 'same') { choice[r.key] = true; picks[r.key].value = 'label'; } };
    const applyChoices = () => {
      let n = 0;
      for (const r of rows) if (r.status !== 'same' && choice[r.key]) { apply(r.key, r.label); n++; }
      toast(n ? `${n} value${n === 1 ? '' : 's'} updated from the label.` : 'No values changed.');
      clear(out);
    };
    out.append(h('div', { class: 'row' }, picture),
      h('div', { class: `banner ${differs ? 'warn' : 'good'}` }, differs
        ? `${differs} value${differs === 1 ? ' differs' : 's differ'} from the record. Compare with the package, then choose which to keep.`
        : news ? 'The values on record match the label. The label also shows values that were not on record.' : 'Everything the reader found matches the record.'),
      parsed.columns ? h('p', { class: 'muted', style: 'margin:0' }, 'This label seems to have two columns. The first amount in each row was used as per 100 g. Check that it is not the per-portion column.') : null,
      h('p', { class: 'muted', style: 'margin:0' }, 'The reader can misread numbers. Check each one against your photo or the package before using it.'),
      h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', { class: 'num' }, 'Recorded'), h('th', { class: 'num' }, 'Label'), h('th', null, ''))), h('tbody', null, body))),
      missing.length ? h('p', { class: 'muted', style: 'margin:0' }, `Not found in the photo: ${missing.join(', ')}.`) : null,
      h('div', { class: 'row' }, differs + news ? h('button', { class: 'primary', onclick: applyChoices }, 'Apply my choices') : null,
        differs + news ? h('button', { onclick: () => { useAll(); } }, 'Select all label values') : null,
        h('button', { onclick: () => clear(out) }, 'Dismiss')),
      raw);
  }

  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, btn, h('span', { class: 'muted' }, 'Photograph the nutrition table to check the numbers above.'), file), out);
}
