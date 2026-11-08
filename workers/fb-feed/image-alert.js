// Processing coverage only. This never infers the contents or intended service
// of an unread image, and never turns factual ambiguity into a technical error.
export function imageImportObservation(source) {
  const result=(state,category=null)=>({state,cause:'automation_failed',category});
  if(!['pending','accepted'].includes(source.review_status)) return result('suppressed');
  if(['pending','processing'].includes(source.processing_status)) return result('pending');
  if(source.extracted_json || source.candidate_json || source.processing_status==='staged') return result('resolved');
  const imageFailure=String(source.validation_reason ?? '').startsWith('Image acquisition failed:');
  if(!source.image_r2_key && !imageFailure) return result('suppressed');
  if(source.failure_kind==='budget') return result('attention','AI daily limit');
  if(source.failure_kind==='exhausted') return result('attention',imageFailure?'Image acquisition retries exhausted':'AI extraction retries exhausted');
  if(source.failure_kind==='permanent' && ['failed','skipped'].includes(source.processing_status)) {
    if(imageFailure) return result('attention','Image acquisition');
    if(String(source.validation_reason ?? '').startsWith('Workers AI extraction failed:')) return result('attention','AI extraction');
  }
  return result('suppressed');
}
