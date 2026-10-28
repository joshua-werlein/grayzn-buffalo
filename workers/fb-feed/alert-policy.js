// Observation policy only. No publication writes, raw payloads, or notifications.
// The caller must provide a current, complete source snapshot. Unknown outcomes
// must never be interpreted as recovery by the durable incident store.
// A null code is not a new incident: the adapter applies that state only to
// previously recorded codes in this observation's own source/subsystem scope.
const observation = (state, code = null) => ({state, code});

export function deliveryAlertObservation(outcome) {
  if (outcome?.status==='published') return observation('resolved');
  if (outcome?.status==='hidden') return observation('suppressed');
  if (outcome?.status==='withheld' && outcome.sourceOutcomes?.some(s=>['cancelled','ambiguous'].includes(s.status))) return observation('suppressed');
  if (outcome?.status==='pending' || outcome?.status==='withheld') return observation('pending');
  if (outcome?.status==='failed' && outcome.expectedActive===true) return observation('attention','delivery_failed');
  return observation('unknown');
}

export function importAlertObservation(source, {eligible = false, resolution = 'unknown'} = {}) {
  if (!eligible || !source) return observation('unknown');
  if (['edited','kept','dismissed'].includes(source.review_status)) return observation('suppressed');
  if (resolution === 'recovered') return observation('resolved');
  if (['pending','processing'].includes(source.processing_status)) return observation('pending');
  // A retained failed record can have successfully reconciled later. Require
  // an explicit current unresolved decision, never a historical fail event.
  if (resolution !== 'unresolved') return observation('unknown');
  if (source.failure_kind === 'budget') return observation('attention','ai_budget_exhausted');
  if (source.failure_kind === 'exhausted') return observation('attention','retry_exhausted');
  if (source.validation_result === 'rejected') return observation('attention','validation_rejected');
  if (['failed','skipped'].includes(source.processing_status)
      && ['permanent','expired'].includes(source.failure_kind)) return observation('attention','import_failed');
  if (source.processing_status === 'staged' && source.validation_result === 'ok') return observation('resolved');
  return observation('unknown');
}

export function dailyPublicationObservation(result) {
  if (!result || typeof result.reason !== 'string') return observation('unknown');
  if (['Current sources awaiting recovery','Concurrent change; nothing written'].includes(result.reason)) return observation('pending');
  if (result.rejectedSources?.length) return observation('attention','publication_blocked');
  if (result.blocked?.length) {
    // A protected destination is still a reviewable publication hold. The
    // verified diagnostic classifies staff protection without calling it an
    // extraction/technical failure; the existing daily key deduplicates sends.
    return observation('attention','publication_blocked');
  }
  if (result.reason === 'No unique current saved week') return observation('attention','publication_blocked');
  // Missing extraction alone does not establish an eligible advertised offer.
  if (result.reason === 'No extracted evidence') return observation('unknown');
  if (['No current sources','No unambiguous eligible changes'].includes(result.reason)
      || (result.written === true && Array.isArray(result.blocked) && Array.isArray(result.rejectedSources))) return observation('resolved');
  return observation('unknown');
}
