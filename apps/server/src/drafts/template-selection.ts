import type {
  ReviewCategoryCandidate,
  ReviewClassification,
} from "../deepseek/client";

export interface ReplyTemplateCandidate {
  sequence: number;
  text: string;
}

type ProductFamily = "headphone" | "speaker" | "amplifier" | "microphone" | "unknown";

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

function productFamily(value: string): ProductFamily {
  const text = normalize(value);
  if (/(?:扩音器|喊话器|小蜜蜂|扩音喇叭)/u.test(text)) return "amplifier";
  if (/(?:音箱|音响|低音炮|桌面扬声器)/u.test(text)) return "speaker";
  if (/(?:耳机|耳麦|耳夹|入耳|半入耳|头戴式|挂耳式)/u.test(text)) return "headphone";
  if (/(?:麦克风|话筒|领夹麦)/u.test(text)) return "microphone";
  return "unknown";
}

function mentionedProductFamilies(value: string): Set<ProductFamily> {
  const text = normalize(value);
  const families = new Set<ProductFamily>();
  if (/(?:扩音器|喊话器|小蜜蜂|扩音喇叭)/u.test(text)) families.add("amplifier");
  if (/(?:音箱|音响|低音炮|桌面扬声器)/u.test(text)) families.add("speaker");
  if (/(?:耳机|耳麦|耳夹式耳机|入耳式耳机|头戴式耳机)/u.test(text)) families.add("headphone");
  if (/(?:麦克风|话筒|领夹麦)/u.test(text)) families.add("microphone");
  return families;
}

function productCompatible(product: string, candidate: string): boolean {
  const current = productFamily(product);
  if (current === "unknown") return true;
  const mentioned = mentionedProductFamilies(candidate);
  if (mentioned.size === 0) return true;
  return mentioned.has(current);
}

interface SemanticAxis {
  group: string;
  review: RegExp;
  template: RegExp;
}

const SEMANTIC_AXES: SemanticAxis[] = [
  {
    group: "wearing",
    review: /(?:有点松|太松|易掉|容易掉|掉落|滑落|戴不稳|夹不稳|不牢|不贴合|太大)/u,
    template: /(?:松紧|易掉|掉落|滑落|戴稳|稳固|牢固|贴合|位置|适配)/u,
  },
  {
    group: "wearing",
    review: /(?:夹得疼|耳朵疼|夹耳|压耳|久戴不适|戴久疼|不舒服|累|有压力)/u,
    template: /(?:疼|不适|夹耳|压耳|佩戴时长|适时放松|无压|舒适)/u,
  },
  {
    group: "sound",
    review: /(?:低重音|低音太重|低频太重|低频过重|轰头|发闷|声音闷)/u,
    template: /(?:低重音|低音|低频|均衡器|音效模式|声音风格)/u,
  },
  {
    group: "connection",
    review: /(?:距离短|超过.{0,5}米|离远|穿透|信号差|远一点|远了)/u,
    template: /(?:连接距离|拉近|距离|遮挡|墙体|干扰源)/u,
  },
  {
    group: "connection",
    review: /(?:开盖.{0,5}连|自动连|秒连|连接很快|连接很稳|没断过)/u,
    template: /(?:开盖|自动连|秒连|连接稳定|不中断|丝滑)/u,
  },
  {
    group: "price",
    review: /(?:买完降价|价格波动|更便宜|差价|优惠|保价|补贴)/u,
    template: /(?:价格|活动|优惠|保价|差价)/u,
  },
  {
    group: "packaging",
    review: /(?:包装|快递盒|盒子|压烂|压坏|破损)/u,
    template: /(?:包装|运输|快递)/u,
  },
  {
    group: "service",
    review: /(?:客服|服务|售后|态度)/u,
    template: /(?:客服|服务|售后|态度)/u,
  },
  {
    group: "appearance",
    review: /(?:颜值|外观|颜色|好看|漂亮)/u,
    template: /(?:颜值|外观|颜色|好看|审美)/u,
  },
  {
    group: "sound",
    review: /(?:音质|声音|音效|高音|低音|听感)/u,
    template: /(?:音质|声音|音效|听觉|听歌)/u,
  },
];

const RISKY_TEMPLATE_PATTERNS: Array<{ pattern: RegExp; penalty: number }> = [
  { pattern: /(?:长期一致|始终一致|永远一致)/u, penalty: 24 },
  { pattern: /(?:保证|绝对|一定会|肯定会)/u, penalty: 16 },
  { pattern: /(?:效果会很好|相信.{0,10}会更好)/u, penalty: 8 },
  { pattern: /(?:升级包装|会和快递方沟通|随时为您解决)/u, penalty: 6 },
  { pattern: /(?:煲机)/u, penalty: 5 },
  { pattern: /。。/u, penalty: 2 },
];

function candidateScore(review: string, product: string, candidate: ReplyTemplateCandidate): number {
  const reviewText = normalize(review);
  const templateText = normalize(candidate.text);
  let score = 0;
  const currentFamily = productFamily(product);
  const mentionedFamilies = mentionedProductFamilies(templateText);
  if (currentFamily !== "unknown" && mentionedFamilies.has(currentFamily)) score += 8;

  const activeAxes = SEMANTIC_AXES.filter((axis) => axis.review.test(reviewText));
  for (const axis of activeAxes) {
    if (axis.template.test(templateText)) {
      score += 10;
      continue;
    }
    const conflictingAxis = SEMANTIC_AXES.some((other) => (
      other.group === axis.group
      && other !== axis
      && other.template.test(templateText)
      && !other.review.test(reviewText)
    ));
    if (conflictingAxis) score -= 8;
  }
  for (const risk of RISKY_TEMPLATE_PATTERNS) {
    if (risk.pattern.test(templateText)) score -= risk.penalty;
  }
  return score;
}

function bestCandidates(
  review: string,
  product: string,
  replies: ReplyTemplateCandidate[],
): ReplyTemplateCandidate[] {
  const compatible = replies.filter((reply) => productCompatible(product, reply.text));
  if (compatible.length === 0) return [];
  const scored = compatible.map((reply) => ({
    reply,
    score: candidateScore(review, product, reply),
  }));
  const bestScore = Math.max(...scored.map((item) => item.score));
  return scored.filter((item) => item.score === bestScore).map((item) => item.reply);
}

export function selectReplyTemplate(input: {
  review: string;
  product: string;
  replies: ReplyTemplateCandidate[];
  fallbackReplies: ReplyTemplateCandidate[];
  pickIndex: (length: number) => number;
}): ReplyTemplateCandidate {
  const categoryCandidates = bestCandidates(input.review, input.product, input.replies);
  const candidates = categoryCandidates.length > 0
    ? categoryCandidates
    : bestCandidates(input.review, input.product, input.fallbackReplies);
  if (candidates.length === 0) {
    throw new Error("没有与当前商品兼容的回复话术");
  }
  const pickedIndex = input.pickIndex(candidates.length);
  if (!Number.isInteger(pickedIndex) || pickedIndex < 0 || pickedIndex >= candidates.length) {
    throw new Error("回复话术选择索引无效");
  }
  return candidates[pickedIndex]!;
}

interface CategoryDimension {
  review: RegExp;
  category: RegExp;
}

const CATEGORY_DIMENSIONS: CategoryDimension[] = [
  { review: /(?:品质|质量|做工|耐用|好用|靠谱)/u, category: /(?:品质|质量|做工)/u },
  { review: /(?:音质|声音|音效|高音|低音|听感|麦克风清晰|通话清晰)/u, category: /(?:音质|音效|声音|通话)/u },
  { review: /(?:颜值|外观|颜色|好看|漂亮)/u, category: /(?:外观|颜值|颜色)/u },
  { review: /(?:续航|电量|充电)/u, category: /(?:续航|电量|充电)/u },
  { review: /(?:佩戴|戴着|夹耳|压耳|容易掉|有点松)/u, category: /(?:佩戴|耳夹)/u },
  { review: /(?:降噪|隔音)/u, category: /(?:降噪|隔音)/u },
  { review: /(?:连接|蓝牙|开盖|断连|信号)/u, category: /(?:连接|蓝牙)/u },
  { review: /(?:客服|服务|售后|态度)/u, category: /(?:服务|客服|售后)/u },
  { review: /(?:物流|发货|到货|快递)/u, category: /(?:物流|配送|发货)/u },
  { review: /(?:包装|快递盒|盒子)/u, category: /(?:包装|防护)/u },
  { review: /(?:性价比|物超所值|划算|超值|价格便宜)/u, category: /(?:性价比|价值|价格)/u },
];

function categoryScore(
  review: string,
  product: string,
  candidate: ReviewCategoryCandidate,
): number {
  const reviewText = normalize(review);
  const categoryText = normalize(`${candidate.primaryCategory}${candidate.category}${candidate.keywords.join("")}`);
  if (!productCompatible(product, categoryText)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  for (const dimension of CATEGORY_DIMENSIONS) {
    if (dimension.review.test(reviewText) && dimension.category.test(categoryText)) score += 12;
  }
  for (const keyword of candidate.keywords) {
    const normalizedKeyword = normalize(keyword);
    if (normalizedKeyword.length >= 2 && reviewText.includes(normalizedKeyword)) {
      score += 10 + Math.min(normalizedKeyword.length, 8);
    }
  }
  const family = productFamily(product);
  if (family !== "unknown" && mentionedProductFamilies(categoryText).has(family)) score += 4;
  return score;
}

export function refineFallbackCategory(input: {
  library: "good" | "bad";
  category: string;
  fallbackCategory: string;
  review: string;
  product: string;
  categories: ReviewCategoryCandidate[];
}): string {
  if (input.category !== input.fallbackCategory) return input.category;
  const scored = input.categories
    .filter((candidate) => candidate.library === input.library && candidate.category !== input.fallbackCategory)
    .map((candidate) => ({
      candidate,
      score: categoryScore(input.review, input.product, candidate),
    }))
    .filter((item) => Number.isFinite(item.score) && item.score >= 12)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) return input.category;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return input.category;
  return scored[0]!.candidate.category;
}

function hasNoUseExperience(review: string): boolean {
  const text = normalize(review);
  const unopened = /(?:送人的|送人|没打开|没有打开|未拆封|还没拆|没使用|还没使用|还没用|尚未使用)/u.test(text);
  const unknown = /(?:不知道|不清楚|没体验|还没试|尚未体验|用后再看)/u.test(text);
  return unopened && unknown;
}

function hasConcreteNegativeProblem(review: string): boolean {
  const text = normalize(review)
    .replace(/(?:没有|没)(?:出现|发现)?(?:任何)?问题/gu, "")
    .replace(/(?:没有|没)(?:损坏|坏|破损|异常|故障)/gu, "")
    .replace(/(?:不差|没有不好|没什么不好)/gu, "");
  return /(?:损坏|坏的|破损|故障|异常|不能|无法|断连|卡顿|杂音|电流声|啸叫|疼|痛|容易掉|有点松|太大|太小|不满意|失望|垃圾|服务差|态度差|太贵|缺少|漏发|少发|压烂|压坏)/u.test(text);
}

export function applyNoUseExperienceGuard(
  classification: ReviewClassification,
  review: string,
  goodFallbackCategory: string,
): ReviewClassification {
  if (classification.library !== "bad"
    || !hasNoUseExperience(review)
    || hasConcreteNegativeProblem(review)) {
    return classification;
  }
  return {
    library: "good",
    category: goodFallbackCategory,
    confidence: Math.max(classification.confidence, 0.9),
    reason: "评价明确说明尚未打开或使用，且未描述当前商品问题，按中性评价使用好评兜底。",
    needsAttention: classification.needsAttention,
  };
}
