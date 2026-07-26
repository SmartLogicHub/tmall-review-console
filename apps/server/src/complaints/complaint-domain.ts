import { createHash, randomUUID } from "node:crypto";

export type ComplaintTypeCode =
  | "purchase_a_review_b"
  | "meaningless_content"
  | "insulting_content"
  | "privacy_leak"
  | "advertising_content"
  | "political_terror_sensitive"
  | "vulgar_sexual_content"
  | "prohibited_goods"
  | "minor_harmful_content"
  | "extortion_for_improper_benefit"
  | "fake_review_before_receipt"
  | "fake_or_online_image"
  | "competitor_malicious_review";

export type FactCode =
  | "review_targets_other_product"
  | "review_is_meaningless"
  | "review_attacks_person"
  | "review_exposes_third_party_privacy"
  | "review_contains_ad_diversion"
  | "review_contains_political_terror_content"
  | "review_contains_vulgar_sexual_content"
  | "review_promotes_prohibited_goods"
  | "review_contains_minor_harm"
  | "review_explicitly_demands_benefit"
  | "usage_claim_before_receipt"
  | "platform_verified_external_image"
  | "review_explicit_competitor_malice";

export interface ComplaintTypeDefinition {
  code: ComplaintTypeCode;
  name: string;
  factCode: FactCode;
  factDescription: string;
}

export const COMPLAINT_TYPES: readonly ComplaintTypeDefinition[] = [
  { code: "purchase_a_review_b", name: "购买A商品评价B商品", factCode: "review_targets_other_product", factDescription: "该评价主要描述的对象与本订单商品不一致" },
  { code: "meaningless_content", name: "评价内容无意义", factCode: "review_is_meaningless", factDescription: "该内容与本订单商品、物流及商家服务均无实际关联" },
  { code: "insulting_content", name: "辱骂侮辱的评论", factCode: "review_attacks_person", factDescription: "该内容包含针对具体人员的人格侮辱或攻击" },
  { code: "privacy_leak", name: "评论泄露隐私", factCode: "review_exposes_third_party_privacy", factDescription: "该评价公开了第三方联系方式、地址或其他可识别隐私信息" },
  { code: "advertising_content", name: "评价内容为广告信息", factCode: "review_contains_ad_diversion", factDescription: "该内容包含与本订单评价无关的推广或交易引流信息" },
  { code: "political_terror_sensitive", name: "涉政暴恐等敏感信息", factCode: "review_contains_political_terror_content", factDescription: "该内容包含涉政、暴恐或极端敏感信息" },
  { code: "vulgar_sexual_content", name: "低俗色情", factCode: "review_contains_vulgar_sexual_content", factDescription: "该内容包含明显低俗、色情或相关引流信息" },
  { code: "prohibited_goods", name: "毒品枪支等违禁品", factCode: "review_promotes_prohibited_goods", factDescription: "该内容包含违禁商品或服务的交易、宣传或引流信息" },
  { code: "minor_harmful_content", name: "涉未成年人", factCode: "review_contains_minor_harm", factDescription: "该内容包含针对未成年人的有害或不当信息" },
  { code: "extortion_for_improper_benefit", name: "利用中差评索取不当利益", factCode: "review_explicitly_demands_benefit", factDescription: "该评价明确以评价处理为条件提出订单正常售后范围外的利益" },
  { code: "fake_review_before_receipt", name: "未收到货但给出与商品实际不符的虚假评价", factCode: "usage_claim_before_receipt", factDescription: "该评价发布时订单尚未签收，但评价描述了具体商品使用体验" },
  { code: "fake_or_online_image", name: "评价使用虚假或网络图片", factCode: "platform_verified_external_image", factDescription: "当前评价图片已被平台可核对信号标记为外部重复来源" },
  { code: "competitor_malicious_review", name: "同行恶意中差评", factCode: "review_explicit_competitor_malice", factDescription: "该评价原文明确表明同行身份并包含竞争报复或威胁表达" },
] as const;

const TYPE_BY_CODE = new Map(COMPLAINT_TYPES.map((item) => [item.code, item]));

export interface ComplaintModelResult {
  decision: "complaint_candidate" | "no_complaint";
  complaintType: ComplaintTypeCode | "none";
  confidence: number;
  quoteStart: number | null;
  quoteEnd: number | null;
  factCode: FactCode | "none";
  reason: string;
}

/** Stable eligibility identity. Narrative confidence/reason are audit details, not candidate identity. */
export function complaintCandidateIdentityDigest(result: ComplaintModelResult): string {
  return complaintCandidateIdentityDigestFromFields({
    decision: result.decision,
    complaintType: result.complaintType,
    factCode: result.factCode,
    quoteStart: result.quoteStart,
    quoteEnd: result.quoteEnd,
  });
}

function complaintCandidateIdentityDigestFromFields(fields: Pick<ComplaintModelResult, "decision" | "complaintType" | "factCode" | "quoteStart" | "quoteEnd">): string {
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
}

export function complaintConfirmationIdentityDigest(confirmation: ComplaintConfirmation): string {
  return complaintCandidateIdentityDigestFromFields({
    decision: "complaint_candidate",
    complaintType: confirmation.complaintType,
    factCode: confirmation.factCode,
    quoteStart: confirmation.quoteStart,
    quoteEnd: confirmation.quoteEnd,
  });
}

const TRACKED_MODEL_INVOCATIONS = new Map<string, { pass: "primary" | "independent_review" | "adjudication"; resultDigest: string }>();
export async function executeTrackedComplaintModelInvocation(
  pass: "primary" | "independent_review" | "adjudication",
  operation: () => Promise<ComplaintModelResult>,
): Promise<{ result: ComplaintModelResult; invocationId: string }> {
  const result = await operation();
  const invocationId = randomUUID();
  TRACKED_MODEL_INVOCATIONS.set(invocationId, { pass, resultDigest: complaintCandidateIdentityDigest(result) });
  return { result, invocationId };
}

/** Trusted program/model-verifier facts only. Buyer text never sets these flags. */
export interface ComplaintEligibilityFacts {
  primaryConfirmation?: ComplaintConfirmation;
  independentConfirmation?: ComplaintConfirmation;
  adjudicationConfirmation?: ComplaintConfirmation;
  targetsOtherProduct?: boolean;
  otherProductExcludedContext?: boolean;
  meaninglessProgramDetected?: boolean;
  targetsSpecificPerson?: boolean;
  personaAttack?: boolean;
  productOnlyNegative?: boolean;
  piiDetected?: boolean;
  piiOwner?: "seller_staff" | "courier" | "named_other" | "reviewer_self" | "public_business" | "unknown";
  hasDiversionSignal?: boolean;
  sensitiveContentConfirmed?: boolean;
  sexualContentConfirmed?: boolean;
  prohibitedTransactionConfirmed?: boolean;
  minorHarmConfirmed?: boolean;
  evaluationConditionPresent?: boolean;
  outOfOrderBenefitDemanded?: boolean;
  reviewedBeforeReceipt?: boolean;
  quoteDescribesUsage?: boolean;
  verifiedExternalImageForCurrentReview?: boolean;
  competitorIdentityExplicit?: boolean;
  competitorMaliceExplicit?: boolean;
  ordinaryNegativeOnly?: boolean;
  normalPoliticsHistoryOnly?: boolean;
  normalBodyOrProductUse?: boolean;
  normalChildProductUse?: boolean;
  normalAfterSalesDemand?: boolean;
  logisticsOnly?: boolean;
  imageSignalForCurrentReview?: boolean;
  shortSentimentExcluded?: boolean;
  logisticsOrServiceExcluded?: boolean;
}

export interface ComplaintConfirmation {
  confirmed: true;
  pass: "primary" | "independent_review" | "adjudication";
  sourceInvocationId: string;
  complaintType: ComplaintTypeCode;
  factCode: FactCode;
  quoteStart: number;
  quoteEnd: number;
}

export interface ValidComplaintCandidate {
  decision: "complaint_candidate";
  complaintType: ComplaintTypeDefinition;
  quote: string;
  confidence: number;
  reason: string;
  redaction: RedactedComplaintAnalysisText;
  analysisScope: ComplaintAnalysisScope;
  validationFacts: ComplaintEligibilityFacts;
  modelResult: ComplaintModelResult;
}

export interface ValidNoComplaint {
  decision: "no_complaint";
  confidence: number;
  reason: string;
}

export type ValidComplaintAnalysis = ValidComplaintCandidate | ValidNoComplaint;

export class ComplaintAnalysisContractError extends Error {
  constructor(message: string) {
    super(`投诉分析结果无法使用：${message}`);
    this.name = "ComplaintAnalysisContractError";
  }
}

export function validateComplaintAnalysis(input: {
  reviewText: string;
  facts: ComplaintEligibilityFacts;
  result: ComplaintModelResult;
}, scope = new ComplaintAnalysisScope()): ValidComplaintAnalysis {
  const { reviewText, result } = input;
  if (!reviewText.trim()) throw new ComplaintAnalysisContractError("评价原文不能为空");
  if (!Number.isInteger(result.confidence) || result.confidence < 0 || result.confidence > 100) {
    throw new ComplaintAnalysisContractError("置信度必须是 0 到 100 的整数");
  }
  if (typeof result.reason !== "string" || !result.reason.trim() || Array.from(result.reason).length > 200) {
    throw new ComplaintAnalysisContractError("审核理由格式错误");
  }
  if (result.decision === "no_complaint") {
    if (result.complaintType !== "none" || result.factCode !== "none" || result.quoteStart !== null || result.quoteEnd !== null) {
      throw new ComplaintAnalysisContractError("不投诉结果不得包含类型、事实或引用");
    }
    return { decision: "no_complaint", confidence: result.confidence, reason: result.reason.trim() };
  }
  if (result.decision !== "complaint_candidate") throw new ComplaintAnalysisContractError("决策字段不受支持");
  const type = TYPE_BY_CODE.get(result.complaintType as ComplaintTypeCode);
  if (!type) throw new ComplaintAnalysisContractError("投诉类型不在官方类型清单中");
  if (result.factCode !== type.factCode) throw new ComplaintAnalysisContractError("事实代码不属于所选投诉类型");
  const quoteStart = result.quoteStart;
  const quoteEnd = result.quoteEnd;
  if (typeof quoteStart !== "number" || typeof quoteEnd !== "number" || !Number.isInteger(quoteStart) || !Number.isInteger(quoteEnd)) {
    throw new ComplaintAnalysisContractError("引用位置必须是整数");
  }
  const codepoints = Array.from(reviewText);
  if (quoteStart < 0 || quoteEnd <= quoteStart || quoteEnd > codepoints.length) {
    throw new ComplaintAnalysisContractError("引用范围无效");
  }
  const quote = codepoints.slice(quoteStart, quoteEnd).join("");
  if (!quote.trim()) throw new ComplaintAnalysisContractError("引用不能为空");
  if (!isFactEligible(type.code, input.facts, result, reviewText)) throw new ComplaintAnalysisContractError("缺少该投诉类型所需的可信事实或排除条件未通过");
  const redaction = issueRedaction(scope, reviewText);
  return issueCandidate(scope, { decision: "complaint_candidate", complaintType: type, quote, confidence: result.confidence, reason: result.reason.trim(), redaction, validationFacts: freezeDeep({ ...input.facts }), modelResult: freezeDeep({ ...result }) });
}

export function hasValidComplaintConfirmationCombination(
  facts: ComplaintEligibilityFacts,
  result: ComplaintModelResult,
  reviewText?: string,
): boolean {
  const reviewCodepoints = reviewText === undefined ? undefined : Array.from(reviewText);
  const hasValidQuote = (confirmation: ComplaintConfirmation) => {
    if (reviewCodepoints === undefined) return true;
    return confirmation.quoteEnd <= reviewCodepoints.length
      && reviewCodepoints.slice(confirmation.quoteStart, confirmation.quoteEnd).join("").trim().length > 0;
  };
  const matchesSemanticClaim = (confirmation: ComplaintConfirmation | undefined) => confirmation?.confirmed === true
    && confirmation.complaintType === result.complaintType
    && confirmation.factCode === result.factCode
    && Number.isInteger(confirmation.quoteStart)
    && Number.isInteger(confirmation.quoteEnd)
    && confirmation.quoteStart >= 0
    && confirmation.quoteEnd > confirmation.quoteStart
    && hasValidQuote(confirmation);
  const validInvocation = (confirmation: ComplaintConfirmation | undefined) => {
    if (!confirmation) return false;
    const tracked = TRACKED_MODEL_INVOCATIONS.get(confirmation.sourceInvocationId);
    const confirmationDigest = complaintConfirmationIdentityDigest(confirmation);
    return tracked?.pass === confirmation.pass && tracked.resultDigest === confirmationDigest;
  };
  const primary = facts.primaryConfirmation?.pass === "primary" && validInvocation(facts.primaryConfirmation) && matchesSemanticClaim(facts.primaryConfirmation);
  const independent = facts.independentConfirmation?.pass === "independent_review" && validInvocation(facts.independentConfirmation) && matchesSemanticClaim(facts.independentConfirmation);
  const adjudication = facts.adjudicationConfirmation?.pass === "adjudication" && validInvocation(facts.adjudicationConfirmation) && matchesSemanticClaim(facts.adjudicationConfirmation);
  const distinct = (first: ComplaintConfirmation | undefined, second: ComplaintConfirmation | undefined) => first?.sourceInvocationId !== second?.sourceInvocationId;
  return primary
    || (adjudication && independent
      && distinct(facts.adjudicationConfirmation, facts.independentConfirmation));
}

export function isFactEligible(type: ComplaintTypeCode, facts: ComplaintEligibilityFacts, result: ComplaintModelResult, reviewText?: string): boolean {
  const confirmed = hasValidComplaintConfirmationCombination(facts, result, reviewText);
  switch (type) {
    case "purchase_a_review_b": return confirmed && facts.targetsOtherProduct === true && facts.otherProductExcludedContext === false;
    case "meaningless_content": return confirmed && facts.meaninglessProgramDetected === true && facts.shortSentimentExcluded === true && facts.logisticsOrServiceExcluded === true;
    case "insulting_content": return confirmed && facts.targetsSpecificPerson === true && facts.personaAttack === true && facts.productOnlyNegative === false;
    case "privacy_leak": return confirmed && facts.piiDetected === true && ["seller_staff", "courier", "named_other"].includes(facts.piiOwner ?? "unknown");
    case "advertising_content": return confirmed && facts.hasDiversionSignal === true && facts.piiDetected === false;
    case "political_terror_sensitive": return confirmed && facts.sensitiveContentConfirmed === true && facts.normalPoliticsHistoryOnly === false;
    case "vulgar_sexual_content": return confirmed && facts.sexualContentConfirmed === true && facts.minorHarmConfirmed === false && facts.normalBodyOrProductUse === false;
    case "prohibited_goods": return confirmed && facts.prohibitedTransactionConfirmed === true && facts.normalPoliticsHistoryOnly === false;
    case "minor_harmful_content": return confirmed && facts.minorHarmConfirmed === true && facts.normalChildProductUse === false;
    case "extortion_for_improper_benefit": return confirmed && facts.evaluationConditionPresent === true && facts.outOfOrderBenefitDemanded === true && facts.normalAfterSalesDemand === false;
    case "fake_review_before_receipt": return confirmed && facts.reviewedBeforeReceipt === true && facts.quoteDescribesUsage === true && facts.logisticsOnly === false;
    case "fake_or_online_image": return confirmed && facts.verifiedExternalImageForCurrentReview === true && facts.imageSignalForCurrentReview === true;
    case "competitor_malicious_review": return confirmed && facts.competitorIdentityExplicit === true && facts.competitorMaliceExplicit === true && facts.ordinaryNegativeOnly === false;
  }
}

export interface RedactedComplaintAnalysisText {
  analysisText: string;
  /** Kept in memory by the caller only. Never persist this mapping. */
  ranges: Array<{ start: number; end: number; kind: "phone" | "account" | "address" }>;
  provenanceToken: string;
  readonly scope: ComplaintAnalysisScope;
}

export class ComplaintAnalysisScope {
  assertRedaction(value: RedactedComplaintAnalysisText): boolean {
    return value.scope === this && SCOPE_TOKENS.get(this)?.get(value.provenanceToken) === value.analysisText && !containsPotentialRawPii(value.analysisText);
  }
  assertCandidate(candidate: ValidComplaintCandidate): boolean {
    return SCOPE_CANDIDATES.get(this)?.get(candidate) === candidateDigest(candidate) && candidate.analysisScope === this && this.assertRedaction(candidate.redaction);
  }
  clear(): void { SCOPE_TOKENS.delete(this); SCOPE_CANDIDATES.delete(this); }
}

const SCOPE_TOKENS = new WeakMap<ComplaintAnalysisScope, Map<string, string>>();
const SCOPE_CANDIDATES = new WeakMap<ComplaintAnalysisScope, WeakMap<object, string>>();
function issueRedaction(scope: ComplaintAnalysisScope, analysisText: string, ranges: RedactedComplaintAnalysisText["ranges"] = []): RedactedComplaintAnalysisText {
  const token = randomUUID();
  const tokens = SCOPE_TOKENS.get(scope) ?? new Map<string, string>();
  tokens.set(token, analysisText); SCOPE_TOKENS.set(scope, tokens);
  return freezeDeep({ analysisText, ranges, provenanceToken: token, scope });
}
function issueCandidate(scope: ComplaintAnalysisScope, candidate: Omit<ValidComplaintCandidate, "analysisScope">): ValidComplaintCandidate {
  const issued = freezeDeep({ ...candidate, analysisScope: scope }) as ValidComplaintCandidate;
  const candidates = SCOPE_CANDIDATES.get(scope) ?? new WeakMap<object, string>();
  candidates.set(issued, candidateDigest(issued)); SCOPE_CANDIDATES.set(scope, candidates);
  return issued;
}

export function redactComplaintAnalysisText(raw: string, scope = new ComplaintAnalysisScope()): RedactedComplaintAnalysisText {
  const ranges: RedactedComplaintAnalysisText["ranges"] = [];
  const patterns: Array<{ pattern: RegExp; kind: RedactedComplaintAnalysisText["ranges"][number]["kind"] }> = [
    { pattern: /(?<!\d)1[\d\s-]{9,13}\d(?!\d)/g, kind: "phone" },
    { pattern: /(?<!\d)\d{16,19}(?!\d)/g, kind: "account" },
    { pattern: /[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/g, kind: "account" },
    { pattern: /(?:微信|vx|V信|账号|帐号)[：:\s]*[A-Za-z][A-Za-z0-9_-]{4,}/gi, kind: "account" },
    { pattern: /[\u4e00-\u9fff]{2,}(?:省|市|区|县|路|街|道)[\u4e00-\u9fff\d-]{2,}(?:号|室|栋|单元)?/g, kind: "address" },
  ];
  let analysisText = raw;
  for (const { pattern, kind } of patterns) {
    analysisText = analysisText.replace(pattern, (match, offset: number) => {
      const start = Array.from(analysisText.slice(0, offset)).length;
      const end = start + Array.from(match).length;
      ranges.push({ start, end, kind });
      return "＊".repeat(Array.from(match).length);
    });
  }
  return issueRedaction(scope, analysisText, ranges);
}

export function hasRedactionProvenance(value: RedactedComplaintAnalysisText): boolean {
  return value.scope instanceof ComplaintAnalysisScope && value.scope.assertRedaction(value);
}

export function containsPotentialRawPii(value: string): boolean {
  return /1[\d\s-]{9,13}\d|\d{16,19}|[\w.-]+@[\w.-]+\.[A-Za-z]{2,}|(?:微信|vx|V信|账号|帐号)[：:\s]*[A-Za-z][A-Za-z0-9_-]{4,}/i.test(value);
}

export function buildComplaintDescription(analysis: ValidComplaintCandidate): string {
  const prefix = "该评价内容为“";
  const suffix = `”。经核对，${analysis.complaintType.factDescription}，符合“${analysis.complaintType.name}”场景。请平台结合评价内容及相关信息审核，并屏蔽处理，谢谢。`;
  const maximumQuoteLength = 1000 - Array.from(prefix + suffix).length;
  const quote = Array.from(analysis.quote).slice(0, maximumQuoteLength).join("");
  const description = `${prefix}${quote}${suffix}`;
  const length = Array.from(description).length;
  if (length < 1 || length > 1000) throw new ComplaintAnalysisContractError("投诉描述长度必须为 1 到 1000 个字符");
  return description;
}

function candidateDigest(candidate: ValidComplaintCandidate): string {
  return JSON.stringify({
    type: candidate.complaintType.code, fact: candidate.complaintType.factCode, factDescription: candidate.complaintType.factDescription,
    quote: candidate.quote, confidence: candidate.confidence, reason: candidate.reason,
    model: candidate.modelResult, facts: candidate.validationFacts,
    redacted: candidate.redaction.analysisText, token: candidate.redaction.provenanceToken,
  });
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}
