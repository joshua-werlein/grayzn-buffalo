// A standalone closure row can close a date on a verified, dated weekly poster.
// Match the whole row so service qualifiers and hours cannot imply a full closure.
/** @param {string | null | undefined} text */
export function isFullDayClosure(text) {
  return /^(?:(?:we are|we['’]re|the restaurant is|restaurant|grayz['’]n buffalo(?: bar & grill)?)\s+)?closed(?:\s+all day)?(?:\s+for\s+(?:the holidays?|thanksgiving(?: day)?|christmas(?: eve| day)?|new year['’]s (?:eve|day)|easter|memorial day|independence day|(?:fourth|4th) of july|labor day))?(?:\s*[,.:–—-]\s*happy\s+(?:holidays|thanksgiving|new year))?[.!]?$/i.test((text ?? '').trim());
}
