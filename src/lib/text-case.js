// One house style for bartender-entered Menu and Specials text, shared by Astro,
// the staff editors and the Facebook Worker: title case. Every word starts with a
// capital letter except a, an, the, and, or, of and with, which stay lowercase
// unless they begin the text or a new entry line.
//
// Only the case of letters changes. Digits, prices, punctuation, apostrophes,
// hyphens, spacing and line breaks are never added, removed or moved, so a
// normalized value has the same length as the text staff typed. Applying it
// twice gives the same result as applying it once.

// Recognized menu abbreviations always print in capitals ("bbq" -> "BBQ").
export const MENU_ACRONYMS = new Set([
  'BBQ', 'BLT', 'FF', 'PB', 'PBR', 'MGD', 'IPA', 'BYOB', 'BOGO', 'AYCE', 'GF',
  'XL', 'XXL', 'TV', 'DJ', 'VIP', 'NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'UFC', 'ESPN', 'USA', 'USDA', 'MSG', 'ABV', 'IBU',
]);
// Brand names whose capitalization title case cannot produce.
const BRANDS = new Map(['DiGiorno', 'LaCroix', 'DeKuyper', 'RumChata', 'MillerCoors', 'SpaghettiOs', 'iPhone', 'eBay', "McDonald's"]
  .map(brand => [brand.toLowerCase(), brand]));
// Capitals inside a word, kept only when typed that way: a surname-style prefix
// (McRib, DiGiorno) or clean CamelCase (PowerAde). Stray capitals (BuRgEr) are not.
const CAMEL_CASE = /^(?:(?:Mc|Mac|Di|De|Da|La|Le|Du)\p{Lu}\p{Ll}+|\p{Lu}\p{Ll}{2,}(?:\p{Lu}\p{Ll}{2,})+)$/u;
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'with']);
// Numbering, bullets, emoji and markup before the first word aren't words.
// Sentence punctuation alone does not restart an entry.
const startsEntry = text => /^[^\p{L}\p{N}$#]*(?:(?:#\d+|\d+[.)]|\$\s*(?:\d+(?:\.\d{2})?|\.\d{2}))\s+[^\p{L}\p{N}$#]*)?$/u
  .test(text.slice(Math.max(text.lastIndexOf('\n'),text.lastIndexOf('\r'))+1)
    .replace(/<[^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/giu,''));
// Units that follow an amount: "8 oz", "$1.10 each", "2 lbs", "12 inch".
const UNITS = new Set(['oz', 'lb', 'lbs', 'pc', 'pcs', 'ct', 'pk', 'ea', 'each', 'inch', 'inches', 'in', 'ft']);
const CLOCK = new Set(['am', 'pm']);
// Whitespace-delimited tokens that are data rather than words.
const TECHNICAL = /:\/\/|^www\.|^[^\s@]+@[^\s@]+\.[^\s@]+$|^[#@/]|^[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|edu|gov|us|io|co|biz|info)(?:[/?#:]|$)/i;
const WORD = /&(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z]+);|\p{L}+(?:['’]\p{L}+)*/gu;

const upperFirst = text => {
  const first = text[0].toUpperCase();
  return (first.length === 1 ? first : text[0]) + text.slice(1);
};
const lower = text => {
  const next = text.toLowerCase();
  return next.length === text.length ? next : text;
};

function caseWord(word, before) {
  const [stem, ...rest] = word.split(/(?=['’])/u);
  const tail = rest.join('');
  const key = word.toLowerCase();
  if (MENU_ACRONYMS.has(stem.toUpperCase())) return stem.toUpperCase() + lower(tail);
  if (BRANDS.has(key)) return BRANDS.get(key);
  if (MINOR_WORDS.has(key) && !startsEntry(before.text)) return key;
  // "w/" and "w/o" keep their established lowercase form.
  if ((key === 'w' && /^\//.test(before.after)) || (key === 'o' && /w\/$/i.test(before.text))) return key;
  const amount = /\d\s*$/.test(before.text);
  if (amount && UNITS.has(key)) return key;
  if (amount && CLOCK.has(key)) return key.toUpperCase();
  if (CAMEL_CASE.test(stem)) return stem + lower(tail);
  // O'Brien, D'Angelo: a one-letter prefix capitalizes the name after it.
  if (stem.length === 1 && tail.length > 2) return stem.toUpperCase() + tail[0] + upperFirst(lower(tail.slice(1)));
  return upperFirst(lower(word));
}

/** Normalize the case of one customer-facing Menu or Specials value. */
export function normalizeMenuCase(text) {
  if (typeof text !== 'string' || !/\p{L}/u.test(text)) return text;
  // Individually priced choice lines are one entry, so a continued "or" or
  // "and" stays lowercase across publication, editor saves and backfill.
  const lines=text.split(/\r\n?|\n/u);
  const pricedChoices=lines.length>1 && lines.every(line=>/^.+\$\s*(?:\d+(?:\.\d{2})?|\.\d{2})/u.test(line));
  // HTML-looking markup and technical tokens (URLs, emails, paths, handles) are untouched.
  return text.split(/(<[^>]*>|\s+)/u).reduce((out, token) => {
    const unwrapped = token.replace(/^[('"“‘]+|[)'"”’.,;!?:]+$/gu, '');
    if (!token || /^\s+$/u.test(token) || /^<[^>]*>$/.test(token) || /^&(?:#\d+|#x[\da-f]+|[a-z]+);$/i.test(token) || TECHNICAL.test(unwrapped)) return out + token;
    return out + token.replace(WORD, (word, offset) =>
      // Letters attached to a number are part of an amount or size (12oz, 2nd, 7UP, 80's, 16"s).
      word.startsWith('&') || /\p{N}['’"”″]*$/u.test(token.slice(0, offset)) ? word
        : caseWord(word, {text: pricedChoices ? (out + token.slice(0, offset)).replace(/\r\n?|\n/gu,' ') : out + token.slice(0, offset), after: token.slice(offset + word.length)}));
  }, '');
}

/** Normalize only a value that differs from what is already stored. */
export const normalizeChangedMenuCase = (next, previous) =>
  typeof next === 'string' && next !== previous ? normalizeMenuCase(next) : next;
