// One display/storage contract shared by Astro, the editor and the Facebook Worker.
// Applies only to the recurring template. Live menu/Facebook prices are allowed.
export function assertPriceFreeMexicanDefault(text) {
  if (/[$¢€£]|\bUSD\b|\b\d+[.,]\d{2}\b|\b\d+(?:\s+|\s*[-–]\s*)(?:dollars?|cents?)\b/i.test(text)) {
    throw new Error('Recurring Mexican Night defaults cannot include prices. Keep names, descriptions and sizes only; Facebook supplies current prices.');
  }
}

export function splitMexicanItem(content) {
  const text = content ?? '';
  const newline = /\r\n|\r|\n/.exec(text);
  return newline
    ? {title: text.slice(0, newline.index), description: text.slice(newline.index + newline[0].length)}
    : {title: text, description: ''};
}

// Mexican Night posters print full descriptions. Ordinary specials keep SPECIAL_LIMIT (150).
export const MEXICAN_ITEM_LIMIT = 300;

// Presentation only: poster dot leaders ("...", "…") before priced text display as " - ".
// Stored Facebook evidence keeps the printed leader.
const DOT_LEADER = /\s*(?:[.·]{2,}|[…‥⋯][.…‥⋯·]*)\s*/g;
export function mexicanDisplayTitle(title) {
  return String(title ?? '').replace(DOT_LEADER, (leader, offset, text) => {
    const before = text.slice(0, offset), after = text.slice(offset + leader.length);
    return before.trim() && /\$\s*\d|\d\s*(?:¢|c\b|cents?\b)/i.test(after) ? ' - ' : leader;
  });
}

// Accessory prices publish in one USD format: 50c -> $0.50, $2 -> $2.00, $1.5 -> $1.50.
// The numeric value is never changed. Text without a recognizable price is untouched.
export function normalizeMexicanPrices(text) {
  return String(text ?? '')
    .replace(/(^|[^\w$.])(\d{1,2})\s*(?:¢|c|cents?)(?![A-Za-z\d])/gi, (_, lead, cents) => `${lead}$0.${cents.padStart(2, '0')}`)
    .replace(/\$\s*(\d*)(?:\.(\d{1,2}))?(?![\d.])/g, (match, dollars, cents) =>
      dollars || cents ? `$${dollars || '0'}.${(cents ?? '').padEnd(2, '0')}` : match);
}

export function composeMexicanItem(title, description) {
  if (typeof title !== 'string' || typeof description !== 'string') throw new Error('Item title and description must be text.');
  if (/[\r\n]/.test(title)) throw new Error('Item / price must be one line.');
  if (!title.trim() && description) throw new Error('A description requires an item title.');
  const content = title + (description ? '\n' + description : '');
  if (content.length > MEXICAN_ITEM_LIMIT) throw new Error(`Item title and description together must be ${MEXICAN_ITEM_LIMIT} characters or fewer.`);
  return content;
}
