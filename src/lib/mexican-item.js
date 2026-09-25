// One display/storage contract shared by Astro, the editor and the Facebook Worker.
export function splitMexicanItem(content) {
  const text = content ?? '';
  const newline = /\r\n|\r|\n/.exec(text);
  return newline
    ? {title: text.slice(0, newline.index), description: text.slice(newline.index + newline[0].length)}
    : {title: text, description: ''};
}

export function composeMexicanItem(title, description) {
  if (typeof title !== 'string' || typeof description !== 'string') throw new Error('Item title and description must be text.');
  if (/[\r\n]/.test(title)) throw new Error('Item / price must be one line.');
  if (!title.trim() && description) throw new Error('A description requires an item title.');
  const content = title + (description ? '\n' + description : '');
  if (content.length > 150) throw new Error('Item title and description together must be 150 characters or fewer.');
  return content;
}
