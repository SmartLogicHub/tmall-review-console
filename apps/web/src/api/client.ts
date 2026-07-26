let csrfToken: string | null = null;
let bootstrapPromise: Promise<void> | null = null;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_session: "本地服务已重新启动，正在恢复连接",
  invalid_csrf: "本地安全会话已更新，请重试",
  invalid_request_origin: "请求来源校验失败，请从本机控制台重新操作",
  invalid_tmall_credentials: "请输入有效的淘宝商家账号和密码",
  tmall_credentials_not_configured: "请先保存淘宝商家账号和密码",
  manual_verification_required: "淘宝需要人工验证，请在已打开的窗口中完成验证",
  identity_mismatch: "当前登录店铺与配置不一致，请检查淘宝账号",
};

async function bootstrap(): Promise<void> {
  if (csrfToken) return;
  if (!bootstrapPromise) {
    bootstrapPromise = fetch("/api/bootstrap", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("本地会话初始化失败");
        const body = (await response.json()) as { csrfToken: string };
        csrfToken = body.csrfToken;
      })
      .finally(() => {
        bootstrapPromise = null;
      });
  }
  await bootstrapPromise;
}

type ErrorBody = { error?: string; detail?: string; message?: string; currentRevision?: number };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function toUserMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

async function readError(response: Response): Promise<{ code: string; message: string; currentRevision?: number }> {
  const text = await response.text();
  let body: ErrorBody = {};
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {
    body = {};
  }
  const code = typeof body.error === "string" ? body.error : "request_failed";
  const detail = typeof body.detail === "string" ? body.detail.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const currentRevision = Number.isInteger(body.currentRevision) && Number(body.currentRevision) > 0
    ? Number(body.currentRevision)
    : undefined;
  const result = { code, message: detail || message || ERROR_MESSAGES[code] || "请求失败，请稍后重试" };
  return currentRevision === undefined ? result : { ...result, currentRevision };
}

export type ApiFetchOptions = {
  replayOnSessionRecovery?: boolean;
};

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  allowSessionRecovery: boolean,
  replayOnSessionRecovery: boolean,
): Promise<T> {
  await bootstrap();
  const method = init?.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init?.headers);
  if (!["GET", "HEAD"].includes(method)) {
    headers.set("X-CSRF-Token", csrfToken ?? "");
    const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
    if (init?.body && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const failure = await readError(response);
    if (allowSessionRecovery && (failure.code === "invalid_session" || failure.code === "invalid_csrf")) {
      csrfToken = null;
      await bootstrap();
      if (replayOnSessionRecovery) return request<T>(path, init, false, true);
      throw new ApiError("本地服务已重新连接，请重新确认此操作", "session_recovered_confirmation_required", 409);
    }
    throw new ApiError(failure.message, failure.code, response.status, failure.currentRevision);
  }
  return (await response.json()) as T;
}

export async function apiFetch<T>(path: string, init?: RequestInit, options: ApiFetchOptions = {}): Promise<T> {
  return request<T>(path, init, true, options.replayOnSessionRecovery !== false);
}

export function resetApiSessionForTests(): void {
  csrfToken = null;
  bootstrapPromise = null;
}
