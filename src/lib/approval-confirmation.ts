// Plain-language rows for the approval confirmation dialog. Display only:
// approveImport() still decides which replacements need explicit confirmation.
export function confirmationRows(rows: any[]) {
  return rows.map(row=>{
    const current=[row.previous?.content,row.previous?.price].filter(Boolean).join(' ');
    const changed=row.content!==(row.previous?.content??'') || !!row.previous?.price;
    // Only flag a replacement when a staff-protected value is actually changing.
    return {place:`${row.groupLabel} · slot ${row.position}`,current:current||'(empty)',next:row.content,changed,
      staffEdited:row.override===true && changed && !!current};
  });
}
