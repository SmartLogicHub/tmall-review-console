export interface FeishuField {
  field_id?: string;
  field_name: string;
  type?: number;
}

export interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

export interface FeishuClientApi {
  testConnection(): Promise<void>;
  listFields(appToken: string, tableId: string): Promise<FeishuField[]>;
  listRecords(appToken: string, tableId: string): Promise<FeishuRecord[]>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  fetchFn?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

interface FeishuEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

interface Page<T> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
}

const AUTH_ERROR_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991666, 99991668]);

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

export class FeishuClient implements FeishuClientApi {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #timeoutMs: number;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(options: FeishuClientOptions) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#fetch = options.fetchFn ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async testConnection(): Promise<void> {
    await this.#getToken();
  }

  async listFields(appToken: string, tableId: string): Promise<FeishuField[]> {
    return this.#listPages<FeishuField>(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      100,
    );
  }

  async listRecords(appToken: string, tableId: string): Promise<FeishuRecord[]> {
    return this.#listPages<FeishuRecord>(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      500,
    );
  }

  async #listPages<T>(path: string, pageSize: number): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    do {
      const query = new URLSearchParams({ page_size: String(pageSize) });
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.#authorizedGet<Page<T>>(`${path}?${query.toString()}`);
      items.push(...(data.items ?? []));
      if (!data.has_more) break;
      if (!data.page_token || seenTokens.has(data.page_token)) {
        throw new FeishuApiError("飞书分页响应无效", "INVALID_PAGINATION", 200);
      }
      seenTokens.add(data.page_token);
      pageToken = data.page_token;
    } while (pageToken);
    return items;
  }

  async #authorizedGet<T>(path: string): Promise<T> {
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      const token = await this.#getToken();
      const response = await this.#fetchWithRetry(`https://open.feishu.cn${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      const envelope = await this.#json<FeishuEnvelope<T>>(response);
      const authenticationFailed =
        response.status === 401 || response.status === 403 || AUTH_ERROR_CODES.has(envelope.code);
      if (authenticationFailed && authAttempt === 0) {
        this.#token = null;
        continue;
      }
      if (!response.ok || envelope.code !== 0 || !envelope.data) {
        throw new FeishuApiError(
          "飞书表格读取失败，请确认应用权限和表格协作者设置",
          envelope.code || response.status,
          response.status,
        );
      }
      return envelope.data;
    }
    throw new FeishuApiError("飞书访问凭证无效", "AUTH_FAILED", 401);
  }

  async #getToken(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt - 5 * 60 * 1000) {
      return this.#token.value;
    }
    const response = await this.#fetchWithRetry(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: this.#appId, app_secret: this.#appSecret }),
      },
    );
    const payload = await this.#json<{
      code: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    }>(response);
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token || !payload.expire) {
      throw new FeishuApiError(
        "无法获取飞书访问凭证，请检查 App ID、App Secret 和应用状态",
        payload.code || response.status,
        response.status,
      );
    }
    this.#token = {
      value: payload.tenant_access_token,
      expiresAt: this.#now() + payload.expire * 1000,
    };
    return this.#token.value;
  }

  async #fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.#fetch(input, {
          ...init,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (response.status !== 429 && response.status < 500) return response;
        lastError = new FeishuApiError(
          "飞书服务暂时不可用，请稍后重试",
          response.status,
          response.status,
        );
      } catch (error) {
        lastError = error;
      }
      if (attempt < 2) await this.#sleep(250 * 2 ** attempt);
    }
    if (lastError instanceof FeishuApiError) throw lastError;
    throw new FeishuApiError("飞书网络请求失败", "NETWORK_ERROR", 0);
  }

  async #json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new FeishuApiError("飞书返回了无法解析的数据", "INVALID_JSON", response.status);
    }
  }
}
