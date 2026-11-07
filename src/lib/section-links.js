// The one list of section links. Pages decide which sections are visible
// (readPublicSections) and SpecialGroup renders a link only for those.
//
// A special links through an explicit section identifier: its own stored
// section_link, or the nightly slot this table names as the section's home. Storing
// section_link on those home slots is not an option: automation treats any linked
// slot as protected, so Facebook could no longer update the nightly special. The
// promotion pattern keeps a different promotion on that night from gaining a link.
export const SECTION_LINKS = Object.freeze({
  'mexican-night': {label: 'Mexican Night →', href: '/specials#mexican-night', day: 2, promotion: /\bmexican\s+night\b/i},
  'wing-wednesday': {label: 'Wing Wednesday →', href: '/specials#wing-wednesday', day: 3, promotion: /\bwing\s+(?:night|wednesday)\b|\bbone[\s-]*(?:in|less)\s+wings?\b/i},
});

export function sectionIdFor(group, slot) {
  if (Object.hasOwn(SECTION_LINKS, slot?.section_link ?? '')) return slot.section_link;
  if (group?.service !== 'nightly') return null;
  const home = Object.entries(SECTION_LINKS).find(([, section]) => section.day === group.day_of_week);
  return home && home[1].promotion.test(slot?.content ?? '') ? home[0] : null;
}

/** The link to show for this special, or null. Hidden sections never get a link. */
export function sectionLinkFor(group, slot, visibleSections = []) {
  const id = sectionIdFor(group, slot);
  return id && visibleSections.includes(id) ? {id, ...SECTION_LINKS[id]} : null;
}

// The printed heading a link replaces. Mexican Night's stock invitation goes with it.
const LINK_HEADING = {
  'mexican-night': /^\s*mexican\s+night\b!?\s*(?:ask\s+to\s+see\s+our\s+menu!?\s*)?/i,
  'wing-wednesday': /^\s*wing\s+(?:night|wednesday)\b!?\s*/i,
};
const PRICE = /\$\s*(?:\d+(?:\.\d{1,2})?|\.\d{1,2})(?:\s*each\b)?/gi;
const staffEdited = slot => slot?.manual_locked === 1 || slot?.manual_edited_at != null;

// A wing price shows only from a verified poster or staff. Every week copies the
// recurring template with unlocked 'manual' ownership, which is neither.
export const wingPriceEligible = slot => staffEdited(slot)
  || (slot?.origin === 'automation' && slot.content === slot.last_auto_value);

function withoutWingPrices(text) {
  const lines = text.split(/\r\n|\r|\n/).flatMap(line => {
    const bare = line.replace(PRICE, ' ').replace(/\s+/g, ' ').trim();
    const options = [/\bbone[\s-]*in\b/i.test(bare) && 'Bone-In Wings', /\bboneless\b/i.test(bare) && 'Boneless Wings'].filter(Boolean);
    return options.length ? options : bare ? [bare] : [];
  });
  const first = lines.indexOf('Boneless Wings'), second = lines.indexOf('Bone-In Wings');
  if (first >= 0 && second > first) [lines[first], lines[second]] = [lines[second], lines[first]];
  return lines.join('\n');
}

/**
 * A recurring wing home slot without its price, or null when there is nothing to remove.
 * Every week copies these before any poster has confirmed a price. Other specials keep theirs.
 */
export function priceFreeWingDefault(group, slot) {
  const stored = [slot?.content ?? '', slot?.price ?? ''].filter(Boolean).join(' ');
  if (sectionIdFor(group, slot) !== 'wing-wednesday' || slot?.section_link || !stored.includes('$')) return null;
  return withoutWingPrices(stored);
}

/**
 * How a special reads on the public board. Stored content is never changed. While its
 * section is visible the link replaces the printed heading; once hidden the special
 * shows as printed. `wing` holds the live section's option lines, for its home slot.
 */
export function presentSpecial(group, slot, visibleSections = [], wing = null) {
  const stored = [slot?.content ?? '', slot?.price ?? ''].filter(Boolean).join(' ');
  const wingHome = sectionIdFor(group, slot) === 'wing-wednesday' && !slot?.section_link;
  const link = sectionLinkFor(group, slot, visibleSections);
  const eligible = wingPriceEligible(slot);
  let text = wingHome && !eligible ? withoutWingPrices(stored) : stored;
  // A price staff approved on the section beats the poster reading it corrected, and a
  // verified section price fills a nightly slot without one. Staff's own slot stands.
  if (wingHome && link && !staffEdited(slot) && wing?.lines.length
    && (wing.source === 'manual' || wing.source === 'facebook' || wing.corrected || (wing.priced && !eligible))) {
    const fries=eligible ? text.split(/\r?\n/).find(line=>/^\s*add\s+fries\b/i.test(line)) : '';
    text=[...wing.lines,fries].filter(Boolean).join('\n');
  }
  // A poster rarely prints the standing Add Fries, and leaving it off doesn't end it.
  if (wingHome && wing?.addFries && !staffEdited(slot) && !/\badd\s+fries\b/i.test(text)) text = `${text}\nAdd Fries`;
  return {link, text: link ? text.replace(LINK_HEADING[link.id], '').trim() : text};
}

/**
 * The homepage card: while the Wing section is visible its home slot is only the link,
 * like Tuesday's Mexican Night. A special staff entered shows instead, as they wrote it.
 */
export function presentHomeSpecial(group, slot, visibleSections = [], wing = null) {
  const shown = presentSpecial(group, slot, visibleSections, wing);
  if (shown.link?.id !== 'wing-wednesday' || slot?.section_link) return shown;
  return staffEdited(slot) ? presentSpecial(group, slot) : {link: shown.link, text: ''};
}

/** Gives an empty Wednesday nightly field the link for rendering. Nothing is stored. */
export function withWingHomeLink(groups, visibleSections = []) {
  if (!visibleSections.includes('wing-wednesday')) return groups;
  return groups.map(group => group.day_of_week === SECTION_LINKS['wing-wednesday'].day && group.service === 'nightly'
    && !group.slots.some(slot => (slot.content ?? '').trim())
    ? {...group, slots: [{position: 1, content: 'Wing Wednesday', price: '', section_link: '', origin: 'manual', manual_locked: 0, last_auto_value: null, manual_edited_at: null}]}
    : group);
}
