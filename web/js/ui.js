// Small DOM helpers. Text is always set with textContent / text nodes, never innerHTML.
import { fmt } from './nutrition.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

export function openModal(content) {
  const m = document.getElementById('modal');
  clear(m);
  m.hidden = false;
  const close = () => { m.hidden = true; clear(m); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  m.onclick = (e) => { if (e.target === m) close(); };
  m.append(h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, content(close)));
  return close;
}

const STATUS_TEXT = { ok: 'OK', near: 'Close', low: 'Low', high: 'Over', info: '' };

/** Nutrient rows -> table with bars. `rows` come from nutrition.evaluate(). */
export function nutrientTable(rows, { groups = null, showTarget = true, notes = {} } = {}) {
  const body = h('tbody');
  let lastGroup = null;
  for (const r of rows) {
    if (groups && !groups.includes(r.group)) continue;
    if (r.group !== lastGroup) {
      lastGroup = r.group;
      body.append(h('tr', null, h('th', { colspan: 4 }, { macro: 'Energy and macronutrients', vitamin: 'Vitamins', mineral: 'Minerals' }[r.group])));
    }
    const tg = r.target;
    let goal = '';
    if (tg) goal = tg.kind === 'min' ? `≥ ${fmt(tg.lo)}` : tg.kind === 'max' ? `≤ ${fmt(tg.hi)}` : `${fmt(tg.lo)}–${fmt(tg.hi)}`;
    const width = r.pct === null ? 0 : Math.min(100, Math.round(r.pct * 100));
    body.append(h('tr', null,
      h('td', null, r.label, notes[r.key] ? h('div', { class: 'muted', style: 'font-size:.78rem' }, notes[r.key]) : null),
      h('td', { class: 'num' }, fmt(r.value, r.unit)),
      showTarget ? h('td', { class: 'num muted' }, goal ? `${goal} ${r.unit}` : '') : null,
      h('td', { style: 'min-width:110px' },
        tg ? h('div', { class: `bar ${r.status}`, title: `${Math.round((r.pct || 0) * 100)}%` }, h('i', { style: `width:${width}%` })) : null,
        tg ? h('span', { class: `status ${r.status}` }, STATUS_TEXT[r.status]) : null)));
  }
  return h('div', { class: 'scroll-x' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', { class: 'num' }, 'Amount'), showTarget ? h('th', { class: 'num' }, 'Target') : null, h('th', null, ''))), body));
}
