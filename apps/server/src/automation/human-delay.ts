import { randomInt } from "node:crypto";
import type { Locator } from "patchright";

export type HumanDelayRange = readonly [minMs: number, maxMs: number];
export type HumanRandomSource = () => number;
export type HumanWait = (milliseconds: number) => Promise<void>;

export interface HumanPacingDependencies {
  random?: HumanRandomSource;
  wait?: HumanWait;
}

export interface HumanActions {
  type(locator: Locator, value: string): Promise<void>;
  click(locator: Locator): Promise<void>;
  delay(range: HumanDelayRange): Promise<void>;
}

const range = (minMs: number, maxMs: number): HumanDelayRange => Object.freeze([minMs, maxMs] as const);

export const TMALL_ACTION_DELAY_RANGES = Object.freeze({
  paginationAfter: range(1_500, 3_500),
  directNavigationAfter: range(1_000, 2_500),
  replyOpenAfter: range(500, 1_200),
  editorFocusAfter: range(300, 700),
  // Once the visible reply text is complete, submit promptly.  The button
  // click itself still has a short natural pacing interval.
  replyFillAfter: range(50, 150),
  submitAfter: range(500, 1_000),
  successPoll: range(400, 800),
  loginFieldGap: range(300, 800),
  loginSubmitBefore: range(500, 1_200),
  loginSubmitAfter: range(1_500, 3_000),
  tradeNavigationAfter: range(800, 2_000),
  reviewNavigationAfter: range(500, 1_500),
  filterAfter: range(400, 1_000),
  reviewInterItem: range(500, 1_200),
});

export const TMALL_BROWSER_PACING_CONFIG = Object.freeze({
  inputFocus: range(200, 500),
  characterDelay: range(60, 180),
  thinkProbability: 0.08,
  thinkPause: range(300, 800),
  clickBefore: range(150, 600),
  clickAfter: range(200, 500),
  viewportWidthOffset: range(-120, 120),
  viewportHeightOffset: range(-80, 80),
  actions: TMALL_ACTION_DELAY_RANGES,
});

const MAX_HUMAN_DELAY_MS = 120_000;
const DEFAULT_WAIT: HumanWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const DEFAULT_RANDOM: HumanRandomSource = () => randomInt(0, 0x1_00_00_00) / 0x1_00_00_00;

function assertDelayRange(minMs: number, maxMs: number): void {
  if (!Number.isSafeInteger(minMs)
    || !Number.isSafeInteger(maxMs)
    || minMs < 0
    || maxMs < minMs
    || maxMs > MAX_HUMAN_DELAY_MS) {
    throw new Error("人性化延迟范围无效");
  }
}

function sampleInclusive(minimum: number, maximum: number, random: HumanRandomSource): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("人性化随机源返回了无效值");
  }
  return minimum + Math.floor(sample * (maximum - minimum + 1));
}

export async function humanDelay(
  minMs: number,
  maxMs: number,
  dependencies: HumanPacingDependencies = {},
): Promise<void> {
  assertDelayRange(minMs, maxMs);
  const milliseconds = sampleInclusive(minMs, maxMs, dependencies.random ?? DEFAULT_RANDOM);
  await (dependencies.wait ?? DEFAULT_WAIT)(milliseconds);
}

export async function humanType(
  locator: Locator,
  value: string,
  dependencies: HumanPacingDependencies = {},
): Promise<void> {
  const random = dependencies.random ?? DEFAULT_RANDOM;
  const wait = dependencies.wait ?? DEFAULT_WAIT;
  try {
    await locator.click();
    await locator.fill("");
    await humanDelay(...TMALL_BROWSER_PACING_CONFIG.inputFocus, { random, wait });
    for (const character of value) {
      const probabilitySample = random();
      if (!Number.isFinite(probabilitySample) || probabilitySample < 0 || probabilitySample >= 1) {
        throw new Error("invalid random source");
      }
      if (probabilitySample < TMALL_BROWSER_PACING_CONFIG.thinkProbability) {
        await humanDelay(...TMALL_BROWSER_PACING_CONFIG.thinkPause, { random, wait });
      }
      const characterDelay = sampleInclusive(...TMALL_BROWSER_PACING_CONFIG.characterDelay, random);
      await locator.pressSequentially(character, { delay: characterDelay });
    }
    if (await locator.inputValue() !== value) {
      throw new Error("input verification failed");
    }
  } catch {
    throw new Error("输入框操作或结果校验失败");
  }
}

export async function humanClick(
  locator: Locator,
  dependencies: HumanPacingDependencies = {},
): Promise<void> {
  const random = dependencies.random ?? DEFAULT_RANDOM;
  const wait = dependencies.wait ?? DEFAULT_WAIT;
  try {
    await humanDelay(...TMALL_BROWSER_PACING_CONFIG.clickBefore, { random, wait });
    await locator.click();
    await humanDelay(...TMALL_BROWSER_PACING_CONFIG.clickAfter, { random, wait });
  } catch (error) {
    throw new Error("页面点击操作失败", { cause: error });
  }
}

export function randomViewport(
  baseWidth = 1_440,
  baseHeight = 900,
  dependencies: Pick<HumanPacingDependencies, "random"> = {},
): { width: number; height: number } {
  if (!Number.isSafeInteger(baseWidth) || !Number.isSafeInteger(baseHeight) || baseWidth <= 0 || baseHeight <= 0) {
    throw new Error("浏览器视口基准尺寸无效");
  }
  const random = dependencies.random ?? DEFAULT_RANDOM;
  return {
    width: Math.max(800, baseWidth + sampleInclusive(...TMALL_BROWSER_PACING_CONFIG.viewportWidthOffset, random)),
    height: Math.max(600, baseHeight + sampleInclusive(...TMALL_BROWSER_PACING_CONFIG.viewportHeightOffset, random)),
  };
}

export function createHumanActions(dependencies: HumanPacingDependencies = {}): HumanActions {
  const actions: HumanActions = {
    type: (locator: Locator, value: string) => humanType(locator, value, dependencies),
    click: (locator: Locator) => humanClick(locator, dependencies),
    delay: ([minMs, maxMs]: HumanDelayRange) => humanDelay(minMs, maxMs, dependencies),
  };
  return Object.freeze(actions);
}
