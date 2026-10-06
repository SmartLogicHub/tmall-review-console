const AFTER_SALES_COMMITMENT_TERMS = [
  "全额",
  "退款",
  "退货",
  "赔偿",
  "补偿",
  "无条件",
  "无理由",
  "保证给您",
  "承诺给您",
] as const;

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

/**
 * Merchant-maintained template wording is trusted.  A final reply becomes
 * unsafe only when it introduces a regulated commitment token that was not
 * present in the selected original template.
 */
export function hasUnapprovedAfterSalesCommitment(
  originalTemplate: string,
  finalReply: string,
): boolean {
  const original = normalize(originalTemplate);
  const final = normalize(finalReply);
  return AFTER_SALES_COMMITMENT_TERMS.some((term) =>
    final.includes(term) && !original.includes(term));
}

