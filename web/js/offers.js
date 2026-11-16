// Turn pasted offer text into {name, sek_per_kg, label, line}. Handles two shapes:
//  1. one offer per line:      "Kycklingfilé 900 g 89,90"  /  "Bananer 14,90 kr/kg"  /  "Broccoli för 14.9 SEK"
//  2. the multi-line blocks you get when copying lidl.se offer tiles:
//       Bananer / 18.90 / Med Lidl Plus / -21% / 14.90* / /kg / I butik 16/11 - 22/11
// Prices are always editable in the UI, so the parser only needs to be useful, not perfect.

const NOISE_LINE = /^(med lidl plus|lidl plus|superpris|i butik.*|[-−–]\s*\d+\s*%|\d+\s*%|nyhet|kampanj|se mer|mer info|ord\.? ?pris.*|jmf\.?-?pris.*)$/i;
const PER_KG = /(\d+(?:[.,]\d+)?)\s*\*?\s*(?:kr|sek|:-)?\s*(?:\/|per)\s*kg\b/i;
const PACK = /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|cl|dl|l)\b/i;
const FOR_SEK = /^(.+?)\s+f(?:ö|o)r\s+(\d+(?:[.,]\d+)?)\s*(?:sek|kr)\.?$/i;
const PRICE_TOKEN = /(\d+(?:[.,]\d{1,2})?)\s*\*?\s*(?:kr|sek|:-)?/gi;

const num = (s) => parseFloat(String(s).replace(',', '.'));

function packKg(qty, unit) {
  const q = num(qty);
  switch (unit.toLowerCase()) {
    case 'kg': return q;
    case 'g': case 'gr': return q / 1000;
    case 'l': return q;          // water-like liquids: 1 l is about 1 kg
    case 'dl': return q / 10;
    case 'cl': return q / 100;
    case 'ml': return q / 1000;
    default: return null;
  }
}

function priceFromText(text) {
  // 1. explicit price per kg
  const pk = PER_KG.exec(text);
  let perKg = pk ? num(pk[1]) : null;
  // 2. a price and a pack size
  const pack = PACK.exec(text.replace(PER_KG, ' '));
  const kg = pack ? packKg(pack[1], pack[2]) : null;
  const rest = text.replace(PER_KG, ' ').replace(PACK, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*%/g, ' ').replace(/\d+\s*-?\s*(?:pack|st|stk|p)/gi, ' ').replace(/x\s*\d+/gi, ' ');
  const prices = [];
  for (const m of rest.matchAll(PRICE_TOKEN)) {
    const v = num(m[1]);
    if (!Number.isFinite(v) || v <= 0 || v > 2000) continue;
    prices.push({ v, star: /\*/.test(m[0]), decimal: /[.,]\d/.test(m[1]) });
  }
  let price = null;
  if (prices.length) {
    const starred = prices.filter((p) => p.star);
    const decimals = prices.filter((p) => p.decimal);
    const pool = decimals.length ? decimals : prices;
    price = starred.length ? starred[starred.length - 1].v : Math.min(...pool.map((p) => p.v));
  }
  if (perKg === null && price !== null && kg) perKg = price / kg;
  return { price, kg, perKg };
}

export function parseOffers(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let block = null;
  const flush = () => {
    if (!block) return;
    const nameLines = block.names;
    const nums = block.rest.join(' ');
    const name = nameLines.join(' ').replace(/\s+/g, ' ').trim();
    if (name) {
      const p = priceFromText(nums);
      out.push({ name, price: p.price, kg: p.kg, sek_per_kg: p.perKg !== null ? Math.round(p.perKg * 100) / 100 : null, line: [name, ...block.rest.filter(Boolean)].join(' · ') });
    }
    block = null;
  };
  for (const line of lines) {
    if (NOISE_LINE.test(line)) continue;
    const f = FOR_SEK.exec(line);
    if (f) { // "Bananer för 14.9 SEK": a self-contained offer; ignore it if the block form follows
      flush();
      out.push({ name: f[1].trim(), price: num(f[2]), kg: null, sek_per_kg: null, line, aria: true });
      continue;
    }
    const hasLetters = /[a-zåäöéü]{3,}/i.test(line);
    const looksPrice = /^\W*\d+(?:[.,]\d+)?\s*\*?\s*(?:kr|sek|:-)?\W*$/.test(line) || (PER_KG.test(line) && !/[a-zåäöéü]{3,}/i.test(line.replace(PER_KG, ' '))) || /^\/\s*(kg|st|förp|l)/i.test(line) || /^(ca\.?\s*)?\d+[.,]?\d*\s*(kg|g|ml|cl|dl|l)\b/i.test(line) || /^\/\s*\w+/.test(line);
    if (hasLetters && !looksPrice) {
      // product name. A new name after a priced block starts a new block.
      if (block && block.rest.some((r) => /\d/.test(r))) flush();
      if (!block) block = { names: [], rest: [] };
      block.names.push(line);
      // one-line form: "Kycklingfilé 900 g 89,90" -> split trailing numbers off the name
      const m = /^(.*?[a-zåäöéü][^\d]*?)\s+((?:ca\.?\s*)?\d.*)$/i.exec(line);
      if (m && /\d/.test(m[2])) {
        const pct = (m[2].match(/\d+(?:[.,]\d+)?\s*%/) || [''])[0];
        block.names[block.names.length - 1] = (m[1].trim() + ' ' + pct).trim();
        block.rest.push(m[2]);
      }
    } else {
      if (!block) block = { names: [], rest: [] };
      block.rest.push(line);
    }
  }
  flush();
  // drop "för X SEK" duplicates when a block with the same name exists
  const blockNames = out.filter((o) => !o.aria).map((o) => o.name.toLowerCase());
  return out.filter((o) => !(o.aria && blockNames.some((b) => b.includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(b))));
}
