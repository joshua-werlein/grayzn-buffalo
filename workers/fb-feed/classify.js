// Caption metadata for the audit/review UI, not an eligibility or write gate.
// Images are extracted independently. Never infer service from a timestamp.
// Version changes make previously staged source versions distinct.
export const PARSER_VERSION = 7;
const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
export function classifyCaption(caption) {
  const result = (kind, day, service, reason, collectionId = null) => ({kind,day,service,collectionId,reason});
  if (typeof caption !== 'string' || !caption.trim()) return result('ignored',null,null,'empty or non-string caption');
  const text = caption.trim();
  if (/\bmexican\s+night\b/i.test(text)) return result('section',-1,null,'Mexican Night phrase detected','mexican-night');
  const days = DAYS.flatMap((name,day) => new RegExp(`\\b${name}\\b`,'i').test(text) ? [day] : []);
  const services = [
    [/\blunch\b/i,'lunch'], [/\b(?:night|nightly)\b/i,'nightly'], [/\ball[\s-]+day\b/i,'all-day'],
  ].filter(([pattern]) => pattern.test(text)).map(([,service]) => service);
  if (/\bweekly\b/i.test(text)) return result('week',null,services.length === 1 ? services[0] : null,'Weekly pattern; review only');
  if (days.length > 1 || services.length > 1) return result('ambiguous',days.length === 1 ? days[0] : null,null,'Multiple days or services; review required');
  if (days.length === 1 && services.length === 1) {
    const day = days[0];
    const phrase = new RegExp(`\\b${DAYS[day]}(?:['’]s)?[\\s:–—-]+(?:lunch|night(?:ly)?|all[\\s-]+day)\\s+specials?\\b`,'i');
    if (phrase.test(text)) return result('week',day,services[0],'Explicit day and service specials');
  }
  if (days.length === 1 && /\bspecials?\b/i.test(text)) return result('ambiguous',days[0],null,'Day Specials; service not explicit');
  return result('ignored',null,null,'no matching specials pattern');
}
