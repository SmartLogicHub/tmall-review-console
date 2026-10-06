import {
  ComplaintReviewService,
  createAdjudicatedComplaintEligibilityVerifier,
  type ComplaintExecutor,
  type ComplaintReviewControl,
  type ComplaintReviewDecision,
  type ComplaintReviewPolicy,
} from "./complaint-review-service";
import { COMPLAINT_TYPES, type ComplaintTypeCode } from "./complaint-domain";
import type { ComplaintAnalysisModel } from "./deepseek-complaint-analysis";
import { DeepSeekConfigurationError } from "../deepseek/client";
import type { ComplaintRepository } from "../storage/complaint-repository";
import type { TmallAuthDriver } from "../tmall/auth-driver";

const complaintTypeCodes = new Set<ComplaintTypeCode>(COMPLAINT_TYPES.map((item) => item.code));

/**
 * The complaint model is a platform-type verifier, not the ordinary review
 * classifier. Sentiment alone is never a complaint signal. Contextual clues
 * only decide whether to request semantic complaint analysis; the model result
 * still needs an exact quote and deterministic platform-fact validation before
 * any complaint can be prepared.
 */
function isComplaintCandidate(draft: Parameters<ComplaintReviewPolicy["evaluate"]>[0]): boolean {
  const review = draft.review.normalize("NFKC");
  const compact = review.replace(/\s+/gu, "");
  const targetedInsult = /(客服|店员|老板|商家|卖家|你们|这个人|工作人员)/u.test(review)
    && /(傻[逼B]|废物|骗子|脑残|去死|畜生|垃圾人|狗东西)/iu.test(review);
  const diversion = /(?:加|联系|私聊|扫码|进群).{0,8}(?:微信|vx|V信|QQ|群|二维码)|(?:微信|vx|V信|QQ).{0,8}(?:购买|下单|咨询|联系|课程)|(?:包装卡片|卡片|扫(?:码|图案)|二维码).{0,16}(?:外部|进群|群聊|领取课程|购买课程)|https?:\/\//iu.test(review);
  const privacy = /(?:身份证(?:号)?|手机号|电话号码|住址|家庭地址|银行卡号).{0,8}[0-9Xx*_-]{4,}|(?<!\d)1[3-9]\d{9}(?!\d)/u.test(review);
  const harmful = /(涉政|恐怖主义|暴恐|炸弹制作|枪支弹药|色情招嫖|成人视频|违禁品|毒品|未成年人.{0,6}(?:色情|裸照|交易))/u.test(review);
  const improperBenefit = /(?:给|要|索取|补偿|返现|红包|好处费).{0,10}(?:删|改)(?:差评|评价)|(?:删|改)(?:差评|评价).{0,10}(?:给钱|补偿|返现|红包)/u.test(review);
  const competitorAttack = /(?:我是|我们是|来自)?(?:同行|竞争对手).{0,12}(?:差评|搞你|恶意|倒闭|别想卖)/u.test(review);
  const wrongProduct = /(?:不是|并非).{0,5}(?:我买|购买|下单).{0,5}(?:的)?(?:商品|产品)|(?:买的|下单的).{0,5}(?:不是|并非).{0,5}(?:这个|该)(?:商品|产品)/u.test(review);
  const fakeReview = /(?:还没|尚未|没有).{0,5}(?:收到|签收).{0,8}(?:先评|评价|好评)|(?:网图|盗图|图片是假的|图片随便找)/u.test(review);
  const characters = Array.from(compact.replace(/[\p{P}\p{S}]/gu, ""));
  const repetition = characters.length >= 3
    && characters.length <= 40
    && (new Set(characters).size <= 2 || /(.)\1{3,}/u.test(compact));
  return targetedInsult || diversion || privacy || harmful || improperBenefit
    || competitorAttack || wrongProduct || fakeReview || repetition;
}

class CandidateScreenedComplaintReviewPolicy implements ComplaintReviewPolicy {
  constructor(
    private readonly complaints: ComplaintRepository,
    private readonly delegate: ComplaintReviewPolicy,
  ) {}

  async evaluate(
    draft: Parameters<ComplaintReviewPolicy["evaluate"]>[0],
    control: ComplaintReviewControl = {},
  ): Promise<ComplaintReviewDecision> {
    if (isComplaintCandidate(draft)) return this.delegate.evaluate(draft, control);
    const existing = this.complaints.findBySource("primary", draft.sourceKey);
    if (!existing) {
      return { action: "reply", caseId: draft.id, caseState: "no_complaint" };
    }
    if (existing.state === "no_complaint" || existing.state === "rejected") {
      return { action: "reply", caseId: existing.id, caseState: existing.state };
    }
    const released = this.complaints.releaseUnstartedAnalysisAsNoComplaint(
      existing.id,
      "未命中投诉候选筛选，按普通评价处理",
    );
    if (released) return { action: "reply", caseId: released.id, caseState: "no_complaint" };
    const releasedCandidate = this.complaints.releaseUnsubmittedCandidateAsNoComplaint(
      existing.id,
      "当前页面评价未命中投诉候选，且旧投诉意向从未点击提交，按普通评价处理",
    );
    if (releasedCandidate) {
      return { action: "reply", caseId: releasedCandidate.id, caseState: "no_complaint" };
    }
    // A validated type, an attempt, or any submission state remains owned by
    // the complaint workflow only after the platform submit boundary has been
    // crossed or the platform exposes an explicit complaint state.
    return this.delegate.evaluate(draft, control);
  }
}

export function bindComplaintAnalysis(client: {
  analyzeComplaint?: ComplaintAnalysisModel["analyzeComplaint"];
}): ComplaintAnalysisModel["analyzeComplaint"] | undefined {
  if (!client.analyzeComplaint) return undefined;
  return (input) => client.analyzeComplaint!(input);
}

export function createProductionComplaintReviewPolicy(options: {
  complaints: ComplaintRepository;
  analyzeComplaint?: ComplaintAnalysisModel["analyzeComplaint"];
  complaintAutoSubmit: boolean;
  executeComplaint?: NonNullable<TmallAuthDriver["executeComplaint"]>;
}): ComplaintReviewPolicy {
  const model: ComplaintAnalysisModel = {
    analyzeComplaint: options.analyzeComplaint ?? (async () => {
      throw new DeepSeekConfigurationError("missing_api_key", "complaint analysis is not configured");
    }),
  };
  const executeComplaint = options.complaintAutoSubmit ? options.executeComplaint : undefined;
  const executor: ComplaintExecutor | undefined = executeComplaint
    ? {
        execute: async ({ case: complaintCase, sourceKey, reviewPhase, beforeSubmit }) => {
          if (!complaintCase.complaintType
            || !complaintTypeCodes.has(complaintCase.complaintType as ComplaintTypeCode)
            || !complaintCase.description) {
            return { state: "failed_before_click", reason: "投诉案件缺少受支持的类型或描述" };
          }
          const result = await executeComplaint({
            sourceKey,
            reviewPhase,
            complaintType: complaintCase.complaintType as ComplaintTypeCode,
            description: complaintCase.description,
            mode: "submit",
            beforeSubmit,
          });
          if (result.state === "sent") {
            if (result.platformCaseId) {
              return result.detailUrl
                ? { state: "submitted", platformCaseId: result.platformCaseId, detailUrl: result.detailUrl }
                : { state: "submitted", platformCaseId: result.platformCaseId };
            }
            return { state: "submitted", detailUrl: result.detailUrl! };
          }
          if (result.state === "uncertain") return { state: "uncertain", reason: result.message };
          if (result.state === "already_handled") return { state: "already_handled", reason: result.message };
          if (result.state === "prepared") return { state: "failed_before_click", reason: "投诉仅完成预填，未获得提交许可" };
          return { state: "failed_before_click", reason: result.message };
        },
      }
    : undefined;

  const factBackedPolicy = new ComplaintReviewService({
    complaints: options.complaints,
    model,
    verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: options.complaints }),
    ...(executor ? { executor } : {}),
  });
  return new CandidateScreenedComplaintReviewPolicy(options.complaints, factBackedPolicy);
}
