import { describe, expect, it } from "vitest";
import { COMPLAINT_ANALYSIS_SYSTEM_PROMPT, ComplaintAnalysisContractError, parseComplaintModelResult, type ComplaintAnalysisModel } from "./deepseek-complaint-analysis";
import { redactComplaintAnalysisText } from "./complaint-domain";

describe("DeepSeek complaint analysis contract", () => {
  it("accepts exactly the controlled structured result shape", () => {
    const parsed = parseComplaintModelResult({
      decision: "no_complaint",
      complaintType: "none",
      confidence: 0,
      quoteStart: null,
      quoteEnd: null,
      factCode: "none",
      reason: "没有可核对依据",
    });
    expect(parsed.decision).toBe("no_complaint");
  });

  it("normalizes DeepSeek's complaint decision alias without weakening the remaining contract", () => {
    const parsed = parseComplaintModelResult({
      decision: "complaint",
      complaintType: "meaningless_content",
      confidence: 90,
      quoteStart: 0,
      quoteEnd: 4,
      factCode: "review_is_meaningless",
      reason: "评价文字无实际语义",
    });

    expect(parsed).toMatchObject({
      decision: "complaint_candidate",
      complaintType: "meaningless_content",
      factCode: "review_is_meaningless",
    });
  });

  it("rejects malformed output and does not permit arbitrary final complaint text", () => {
    expect(() => parseComplaintModelResult({
      decision: "no_complaint", complaintType: "none", confidence: 0,
      quoteStart: null, quoteEnd: null, factCode: "none", reason: "x", finalDescription: "伪造",
    })).toThrow(ComplaintAnalysisContractError);
    expect(() => parseComplaintModelResult({ decision: "no_complaint" })).toThrow(ComplaintAnalysisContractError);
  });

  it("exposes a separate analysis-only interface without chat or evidence operations", async () => {
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: async () => ({
        decision: "no_complaint", complaintType: "none", confidence: 0,
        quoteStart: null, quoteEnd: null, factCode: "none", reason: "没有依据",
      }),
    };
    const result = await model.analyzeComplaint({ pass: "primary", review: redactComplaintAnalysisText("正常评价"), officialTypes: [] });
    expect(result.decision).toBe("no_complaint");
    expect(Object.keys(model)).toEqual(["analyzeComplaint"]);
  });

  it("tells every analysis pass that regional service limitations are ordinary product experience", () => {
    expect(COMPLAINT_ANALYSIS_SYSTEM_PROMPT).toContain("台湾");
    expect(COMPLAINT_ANALYSIS_SYSTEM_PROMPT).toContain("香港");
    expect(COMPLAINT_ANALYSIS_SYSTEM_PROMPT).toContain("澳门");
    expect(COMPLAINT_ANALYSIS_SYSTEM_PROMPT).toContain("地区");
    expect(COMPLAINT_ANALYSIS_SYSTEM_PROMPT).toContain("no_complaint");
  });

  it("does not require exaggerated severity when the review clearly matches an official complaint type", () => {
    expect(COMPLAINT_ANALYSIS_SYSTEM_PROMPT).toContain("不要求额外的严重程度词");
    expect(COMPLAINT_ANALYSIS_SYSTEM_PROMPT).toContain("事实能够与官方投诉类型明确对应");
  });
});
