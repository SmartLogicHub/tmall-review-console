import { createHash } from "node:crypto";

export type TmallSentimentLabel = "positive" | "negative" | "neutral" | "unknown";
export type TmallReviewPhase = "initial" | "followup";
export type TmallPlatformComplaintEntryState = "available" | "unavailable" | "unknown";
export type TmallPlatformActionState =
  | "none"
  | "complaint_record"
  | "complaint_under_review"
  | "complaint_upheld"
  | "complaint_rejected"
  | "reply_record"
  | "non_replyable";

export interface TmallReviewSnapshot {
  sourceKey: string;
  orderId: string | null;
  review: string;
  product: string;
  reviewedAt: string | null;
  sentimentLabel: TmallSentimentLabel;
  itemId: string | null;
  reviewPhase: TmallReviewPhase;
  platformActionState?: TmallPlatformActionState;
  platformComplaintEntryState?: TmallPlatformComplaintEntryState;
}

export interface TmallReviewRowInput {
  rawText: string;
  productCandidates: string[];
  reviewCandidates: string[];
  phaseReviewCandidates: TmallPhaseReviewCandidate[];
  productLinkCandidates: string[];
  platformActionText?: string;
  platformActionLabels?: string[];
  reviewPhase: TmallReviewPhase;
  rowIndex: number;
}

export interface TmallPhaseReviewCandidate {
  text: string;
  reviewPhase: TmallReviewPhase;
  reviewedAt: string;
}

export class TmallReviewPageStateError extends Error {
  constructor(message: string) {
    super(`天猫评价页面状态不可信：${message}`);
    this.name = "TmallReviewPageStateError";
  }
}

const PRODUCT_LINK_BASE_URL = "https://detail.tmall.com/";
const PRODUCT_DETAIL_HOSTS = new Set(["detail.tmall.com", "item.taobao.com"]);
const PRODUCT_DETAIL_PATHS = new Set(["/item.htm"]);

function hasExplicitAuthorityPort(href: string): boolean {
  const value = href.trim();
  const authorityStart = value.startsWith("//")
    ? 2
    : /^[a-z][a-z\d+.-]*:\/\//iu.test(value)
      ? value.indexOf("//") + 2
      : -1;
  if (authorityStart < 0) return false;
  const authority = value.slice(authorityStart).split(/[/?#]/u, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostPort.includes(":");
}

function parseTmallProductDetailUrl(href: string): URL | null {
  if (typeof href !== "string" || !href.trim()) return null;
  if (hasExplicitAuthorityPort(href)) return null;
  let parsed: URL;
  try {
    parsed = new URL(href, PRODUCT_LINK_BASE_URL);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!PRODUCT_DETAIL_HOSTS.has(hostname)) return null;
  if (!PRODUCT_DETAIL_PATHS.has(parsed.pathname)) return null;
  return parsed;
}

export function isTmallProductDetailLink(href: string): boolean {
  return parseTmallProductDetailUrl(href) !== null;
}

export function parseTmallItemId(href: string): string | null {
  const parsed = parseTmallProductDetailUrl(href);
  if (!parsed) return null;
  const ids = parsed.searchParams.getAll("id");
  if (ids.length === 0 || ids.some((id) => !/^[1-9]\d*$/u.test(id))) return null;
  const uniqueIds = new Set(ids);
  return uniqueIds.size === 1 ? ids[0]! : null;
}

export function resolveTmallItemIdCandidates(hrefs: readonly string[]): string | null {
  const ids = new Set(hrefs.map(parseTmallItemId).filter((id): id is string => id !== null));
  if (ids.size > 1) throw new TmallReviewPageStateError("同一评价的商品ID存在冲突");
  return ids.values().next().value ?? null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueTexts(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

export function platformActionStateFromText(
  text: string,
  reviewPhase: TmallReviewPhase,
): TmallPlatformActionState {
  const normalized = normalizeText(text);
  const complaintRecordMarker = reviewPhase === "initial" ? "投诉评价记录" : "投诉追评记录";
  const otherComplaintRecordMarker = reviewPhase === "initial" ? "投诉追评记录" : "投诉评价记录";
  const replyRecordMarker = reviewPhase === "initial" ? "评价回复记录" : "追评回复记录";
  const otherReplyRecordMarker = reviewPhase === "initial" ? "追评回复记录" : "评价回复记录";

  // The caller must pass text from the DOM surface dedicated to the current
  // review phase.  Phase-specific record markers are checked again here so a
  // broad container can never make an initial review inherit a follow-up
  // action (or vice versa).
  const phaseText = normalized
    .replaceAll(otherComplaintRecordMarker, "")
    .replaceAll(otherReplyRecordMarker, "");

  if (/(?:投诉成立|投诉已成立|判定投诉成立|投诉成功|投诉处理成功|投诉已成功)/u.test(phaseText)) return "complaint_upheld";
  if (/(?:投诉不成立|投诉未通过|投诉驳回|投诉已驳回)/u.test(phaseText)) return "complaint_rejected";
  if (/(?:投诉处理中|投诉审核中|平台审核中|等待平台审核)/u.test(phaseText)) return "complaint_under_review";
  if (phaseText.includes(complaintRecordMarker)) return "complaint_record";
  if (phaseText.includes(replyRecordMarker)) return "reply_record";
  if (/(?:已超过回复期限|回复已关闭|无法回复)/u.test(phaseText)) return "non_replyable";
  return "none";
}

export function platformActionEvidenceFromLabels(
  labels: readonly string[],
  reviewPhase: TmallReviewPhase,
): {
  platformActionState: TmallPlatformActionState;
  complaintEntryState: TmallPlatformComplaintEntryState;
} {
  const visibleLabels = uniqueTexts([...labels]);
  const complaintEntry = reviewPhase === "initial" ? "投诉评价" : "投诉追评";
  const replyEntry = reviewPhase === "initial" ? "评价回复" : "追评回复";
  const complaintRecord = reviewPhase === "initial" ? "投诉评价记录" : "投诉追评记录";
  const replyRecord = reviewPhase === "initial" ? "评价回复记录" : "追评回复记录";
  const platformActionState = platformActionStateFromText(visibleLabels.join("\n"), reviewPhase);
  const complaintEntryState: TmallPlatformComplaintEntryState = visibleLabels.includes(complaintEntry)
    ? "available"
    : visibleLabels.includes(replyEntry)
      || visibleLabels.includes(complaintRecord)
      || visibleLabels.includes(replyRecord)
      || platformActionState !== "none"
      ? "unavailable"
      : "unknown";
  return { platformActionState, complaintEntryState };
}

function sentimentFromText(text: string): TmallSentimentLabel {
  if (/正面评价/u.test(text)) return "positive";
  if (/负面评价/u.test(text)) return "negative";
  if (/中性评价/u.test(text)) return "neutral";
  return "unknown";
}

function isMetadataLine(line: string): boolean {
  return /^(?:正面评价|负面评价|中性评价|情感识别中|评价回复|追评回复|投诉评价|投诉追评)$/u.test(line)
    || /^订单号[:：]/u.test(line)
    || /^(?:初次评价|追评|追加评价)[:：]\s*(?:\d{4}-\d{2}-\d{2}|收货后\d+天)/u.test(line)
    || /^还有\d+天可回复/u.test(line)
    || /^.{0,4}\*{1,3}$/u.test(line);
}

export function parseTmallReviewRow(input: TmallReviewRowInput): TmallReviewSnapshot {
  const rawText = input.rawText.replace(/\r/gu, "");
  const orderId = rawText.match(/订单号[:：]\s*(\d{8,})/u)?.[1] ?? null;
  let reviewedAt = rawText.match(/初次评价[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/u)?.[1] ?? null;
  const productCandidates = uniqueTexts(input.productCandidates)
    .filter((value) => !isMetadataLine(value) && !/订单号|评价回复|投诉/u.test(value));
  const product = productCandidates.sort((left, right) => right.length - left.length)[0] ?? "商品名称未识别";

  const phaseCandidates = input.phaseReviewCandidates.filter((candidate) => candidate.reviewPhase === input.reviewPhase)
    .map((candidate) => ({
      text: normalizeText(candidate.text),
      reviewedAt: candidate.reviewedAt.trim().replace(/^收货后\s*(\d+)\s*天$/u, "收货后$1天"),
    }))
    .filter((candidate) => candidate.text && (
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/u.test(candidate.reviewedAt)
      || (input.reviewPhase === "followup" && (/^收货后\d+天$/u.test(candidate.reviewedAt) || candidate.reviewedAt === "追加评价"))
    ));
  const uniquePhaseCandidates = [...new Map(phaseCandidates.map((candidate) => [`${candidate.reviewedAt}\0${candidate.text}`, candidate])).values()];
  if (input.reviewPhase === "followup" && uniquePhaseCandidates.length !== 1) {
    throw new TmallReviewPageStateError("追评正文和时间无法安全确认");
  }
  if (uniquePhaseCandidates.length > 1) {
    throw new TmallReviewPageStateError("当前评价阶段存在多个正文或时间");
  }
  const phaseCandidate = uniquePhaseCandidates[0];
  if (phaseCandidate && /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/u.test(phaseCandidate.reviewedAt)) {
    reviewedAt = phaseCandidate.reviewedAt;
  }

  let reviewCandidates = phaseCandidate
    ? [phaseCandidate.text]
    : uniqueTexts(input.reviewCandidates.flatMap((value) => value.split(/\r?\n/gu)))
      .filter((value) => !isMetadataLine(value) && value !== product);
  if (reviewCandidates.length === 0) {
    reviewCandidates = uniqueTexts(rawText.split("\n"))
      .filter((value) => !isMetadataLine(value) && value !== product && !productCandidates.includes(value));
  }
  reviewCandidates.sort((left, right) => right.length - left.length);
  const review = reviewCandidates[0] ?? "";
  if (!review) throw new Error(`第 ${input.rowIndex + 1} 条评论无法识别评论内容`);

  const sourceMaterial = `${orderId ?? "no-order"}\0${reviewedAt ?? "no-time"}\0${product}\0${review}\0${input.reviewPhase}`;
  const digest = createHash("sha256").update(sourceMaterial, "utf8").digest("hex").slice(0, 24);
  const platformEvidence = input.platformActionLabels
    ? platformActionEvidenceFromLabels(input.platformActionLabels, input.reviewPhase)
    : {
        platformActionState: platformActionStateFromText(input.platformActionText ?? "", input.reviewPhase),
        complaintEntryState: "unknown" as const,
      };
  return {
    sourceKey: `tmall:${orderId ?? "unknown"}:${digest}`,
    orderId,
    review,
    product,
    reviewedAt,
    sentimentLabel: sentimentFromText(rawText),
    itemId: resolveTmallItemIdCandidates(input.productLinkCandidates),
    reviewPhase: input.reviewPhase,
    platformActionState: platformEvidence.platformActionState,
    platformComplaintEntryState: platformEvidence.complaintEntryState,
  };
}
