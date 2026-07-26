export interface ManualProductIdentity {
  itemId?: string | null;
  title: string;
}

export type ManualProductMatchResult<T extends ManualProductIdentity = ManualProductIdentity> =
  | {
    status: "matched";
    matchedBy: "item_id" | "normalized_title";
    product: T;
  }
  | {
    status: "not_matched";
  }
  | {
    status: "identity_untrusted";
  }
  | {
    status: "ambiguous";
    candidates: T[];
  };

export interface ManualProductIdentityPatch {
  itemId: string | null;
  title: string;
  normalizedTitle: string;
}

export type ManualProductIdentityResolution<T extends ManualProductIdentity = ManualProductIdentity> =
  | {
    status: "matched";
    matchedBy: "item_id" | "normalized_title";
    target: T;
    patch: ManualProductIdentityPatch;
    mergeCandidates: T[];
  }
  | {
    status: "not_matched";
    patch: ManualProductIdentityPatch;
  }
  | {
    status: "ambiguous";
    candidates: T[];
  }
  | {
    status: "invalid_input";
    reason: "empty_normalized_title" | "missing_item_id";
  };

const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/gu;
const LATIN_PATTERN = /\p{Script=Latin}+/gu;
const NON_LETTER_OR_NUMBER_PATTERN = /[^\p{L}\p{N}]/gu;

export function normalizeManualProductTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(LATIN_PATTERN, (value) => value.toLowerCase())
    .replace(NON_LETTER_OR_NUMBER_PATTERN, "");
}

function normalizedItemId(value: string | null | undefined): string | null {
  const itemId = value?.trim() ?? "";
  return itemId.length > 0 ? itemId : null;
}

function fromCandidates<T extends ManualProductIdentity>(
  candidates: T[],
  matchedBy: "item_id" | "normalized_title",
): ManualProductMatchResult<T> {
  if (candidates.length === 0) return { status: "not_matched" };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "matched", matchedBy, product: candidates[0]! };
}

function identityPatch(
  itemId: string | null,
  title: string,
  normalizedTitle: string,
): ManualProductIdentityPatch {
  return { itemId, title, normalizedTitle };
}

function resolvedIdentity<T extends ManualProductIdentity>(
  target: T,
  patch: ManualProductIdentityPatch,
  matchedBy: "item_id" | "normalized_title",
  mergeCandidates: T[] = [],
): ManualProductIdentityResolution<T> {
  return {
    status: "matched",
    matchedBy,
    target,
    patch,
    mergeCandidates,
  };
}

export function resolveManualProductIdentity<T extends ManualProductIdentity>(
  incoming: ManualProductIdentity,
  existing: readonly T[],
): ManualProductIdentityResolution<T> {
  const itemId = normalizedItemId(incoming.itemId);
  if (!itemId) return { status: "invalid_input", reason: "missing_item_id" };
  const sameId = existing.filter((product) => normalizedItemId(product.itemId) === itemId);
  if (sameId.length > 1) return { status: "ambiguous", candidates: sameId };
  if (sameId.length === 1) {
    const target = sameId[0]!;
    const title = incoming.title.trim() || target.title;
    return resolvedIdentity(
      target,
      identityPatch(itemId, title, normalizeManualProductTitle(title)),
      "item_id",
    );
  }
  const title = incoming.title.trim();
  return {
    status: "not_matched",
    patch: identityPatch(itemId, title, normalizeManualProductTitle(title)),
  };
}

export function matchManualProduct<T extends ManualProductIdentity>(
  review: ManualProductIdentity,
  products: readonly T[],
): ManualProductMatchResult<T> {
  const itemId = normalizedItemId(review.itemId);
  if (!itemId) return { status: "identity_untrusted" };
  const sameId = products.filter((product) => normalizedItemId(product.itemId) === itemId);
  return fromCandidates(sameId, "item_id");
}
