import { describe, expect, it } from "vitest";
import { classifyTmallAuthenticationText } from "./auth-driver";

describe("Tmall authentication page classification", () => {
  it.each([
    "账号或密码错误",
    "登录失败，账号名或登录密码错误",
    "密码不正确，请重新输入",
    "该账号不存在，请重新输入",
    "账户已被锁定",
  ])("treats only explicit credential rejection copy as credential_rejected: %s", (bodyText) => {
    expect(classifyTmallAuthenticationText({ bodyText, loginPageVisible: true })).toBe("credential_rejected");
  });

  it.each([
    "请完成短信验证",
    "请使用手机扫码登录",
    "需要电话验证当前设备",
    "请拖动滑块完成验证",
    "账号存在安全风险，请完成身份验证",
  ])("routes verification copy to manual verification: %s", (bodyText) => {
    expect(classifyTmallAuthenticationText({ bodyText, loginPageVisible: true })).toBe("manual_verification_required");
  });

  it("recognizes a safe onboarding guide without treating it as a password failure", () => {
    expect(classifyTmallAuthenticationText({ bodyText: "欢迎使用千牛，这是新手引导", loginPageVisible: false })).toBe("onboarding_or_safe_guide");
    expect(classifyTmallAuthenticationText({ bodyText: "重要消息 预警通知 发货异常提醒 预计赔付金额494.21元", loginPageVisible: false })).toBe("onboarding_or_safe_guide");
  });

  it("keeps an otherwise unresolved login page in a recoverable not-ready state", () => {
    expect(classifyTmallAuthenticationText({ bodyText: "欢迎登录千牛", loginPageVisible: true })).toBe("not_ready");
    expect(classifyTmallAuthenticationText({ bodyText: "登录失败，请检查账号名和登录密码", loginPageVisible: true })).toBe("not_ready");
  });

  it("does not mistake the normal password page login-method labels for an active verification challenge", () => {
    expect(classifyTmallAuthenticationText({
      bodyText: "欢迎登录 密码登录 短信登录 扫码登录更便捷 账号名/邮箱/手机号 请输入登录密码 登录",
      loginPageVisible: true,
    })).toBe("not_ready");
    expect(classifyTmallAuthenticationText({
      bodyText: "请输入手机号/会员名/邮箱，也可使用手机号登录",
      loginPageVisible: true,
    })).toBe("not_ready");
  });

  it("does not mistake ordinary login-page footer links for a business popup", () => {
    expect(classifyTmallAuthenticationText({
      bodyText: "欢迎登录 密码登录 账号名/邮箱/手机号 请输入登录密码 登录 投诉举报 退款规则",
      loginPageVisible: true,
    })).toBe("not_ready");
  });

  it("never lets complaint, refund, punishment, or business-confirmation overlays become safe onboarding", () => {
    expect(classifyTmallAuthenticationText({ bodyText: "新手引导：请确认提交退款投诉处理", loginPageVisible: false })).toBe("manual_action_required");
    expect(classifyTmallAuthenticationText({ bodyText: "重要消息 退款投诉处罚处理提醒", loginPageVisible: false })).toBe("manual_action_required");
  });
});
