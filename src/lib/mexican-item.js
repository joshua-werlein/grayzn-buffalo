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

export function composeMexicanItem(title, description) {
  if (typeof title !== 'string' || typeof description !== 'string') throw new Error('Item title and description must be text.');
  if (/[\r\n]/.test(title)) throw new Error('Item / price must be one line.');
  if (!title.trim() && description) throw new Error('A description requires an item title.');
  const content = title + (description ? '\n' + description : '');
  if (content.length > MEXICAN_ITEM_LIMIT) throw new Error(`Item title and description together must be ${MEXICAN_ITEM_LIMIT} characters or fewer.`);
  return content;
}
