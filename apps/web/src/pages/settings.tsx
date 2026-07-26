import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CalendarClock, ChevronRight, CircleCheck, Database, KeyRound, LockKeyhole, LogIn, RefreshCw, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, toUserMessage } from "../api/client";
import { StatusPill } from "../components/status-pill";

type AuthStatus = {
  state: string;
  configured: boolean;
  maskedAccount: string | null;
  storeName?: string | null;
  lastLoginAt?: string | null;
  lastFailure?: string | null;
};

type Settings = {
  pollingIntervalSeconds: number;
  batchSize: number;
  retryCount: number;
  deepseekBaseUrl: string;
  dailyModel: string;
  repairModel: string;
  feishuAppId: string;
  feishuAppSecretConfigured: boolean;
  deepseekApiKeyConfigured: boolean;
  deepseekLastLatencyMs?: number | null;
  complaintAutoSubmit: boolean;
  adapters: Record<string, string>;
};

type DeepSeekModelCheck =
  | { model: string; status: "ready"; latencyMs: number }
  | { model: string; status: "error"; detail: string };

type DeepSeekConnectionTest = {
  adapter: "deepseek";
  status: "ready" | "error";
  models: string[];
  latencyMs: number;
  checks?: { pro: DeepSeekModelCheck };
};

function deepSeekCheckText(label: "Pro", check: DeepSeekModelCheck): string {
  return check.status === "ready"
    ? `${label} 验证通过（${check.latencyMs} ms）`
    : `${label} 验证失败：${check.detail}`;
}

type StorageState = {
  usedBytes: number;
  limitBytes: number;
  browserProfileBytes: number;
  nextCleanupAt?: string | null;
  lastCleanupAt?: string | null;
  counts: {
    reviews: number;
    submissionAudit: number;
    manualProducts: number;
    manualHolds: number;
    actionTombstones: number;
    locatorRepairs: number;
    locatorSnapshots: number;
    runs: number;
    templateVersions: number;
  };
};
type AutomationPlan = { enabled: boolean; paused: boolean; timezone: "Asia/Shanghai"; intervalMinutes: number; windows: Array<{ id: string; start: string; end: string }>; revision: number };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuSecret, setFeishuSecret] = useState("");
  const auth = useQuery({ queryKey: ["tmall-auth"], queryFn: () => apiFetch<AuthStatus>("/api/tmall-auth/status") });
  const shouldContinueExistingTmallSession = [
    "manual_verification_required",
    "manual_action_required",
    "not_ready",
    "navigation_failed",
  ].includes(auth.data?.state ?? "");
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => apiFetch<Settings>("/api/settings") });
  const storage = useQuery({ queryKey: ["storage"], queryFn: () => apiFetch<StorageState>("/api/storage") });
  const automationPlan = useQuery({ queryKey: ["automation-plan"], queryFn: () => apiFetch<AutomationPlan>("/api/automation-plan") });

  useEffect(() => {
    if (settings.data && !feishuAppId) setFeishuAppId(settings.data.feishuAppId);
  }, [settings.data, feishuAppId]);

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["settings"] }),
      queryClient.invalidateQueries({ queryKey: ["tmall-auth"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  };

  const saveTmall = useMutation({
    mutationFn: async () => {
      const value = { account, password };
      setPassword("");
      const prepared = await apiFetch<{ nonce: string }>("/api/tmall-auth/credentials/prepare", { method: "POST", body: JSON.stringify({ action: "replace" }) });
      await apiFetch("/api/tmall-auth/credentials", { method: "PUT", body: JSON.stringify({ nonce: prepared.nonce, ...value }) });
      return apiFetch<AuthStatus>("/api/tmall-auth/open-review-page", { method: "POST" });
    },
    onSuccess: () => { setAccount(""); },
    onSettled: refreshAll,
  });
  const verifyTmall = useMutation({
    mutationFn: () => apiFetch<AuthStatus>(shouldContinueExistingTmallSession ? "/api/tmall-auth/continue" : "/api/tmall-auth/open-review-page", { method: "POST" }),
    onSettled: refreshAll,
  });
  const deleteTmall = useMutation({
    mutationFn: async () => {
      const prepared = await apiFetch<{ nonce: string }>("/api/tmall-auth/credentials/prepare", { method: "POST", body: JSON.stringify({ action: "delete" }) });
      return apiFetch("/api/tmall-auth/credentials", { method: "DELETE", body: JSON.stringify({ nonce: prepared.nonce }) });
    },
    onSuccess: refreshAll,
  });

  const testDeepSeek = useMutation({
    mutationFn: () => apiFetch<DeepSeekConnectionTest>("/api/connections/deepseek/test", { method: "POST" }),
    onSuccess: refreshAll,
  });
  const saveDeepSeek = useMutation({
    mutationFn: async () => {
      const key = deepseekKey;
      setDeepseekKey("");
      await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ deepseekBaseUrl: "https://api.deepseek.com" }) });
      const prepared = await apiFetch<{ nonce: string }>("/api/secrets/deepseek_api_key/prepare", { method: "POST", body: JSON.stringify({ action: "replace" }) });
      return apiFetch("/api/secrets/deepseek_api_key", { method: "PUT", body: JSON.stringify({ nonce: prepared.nonce, secret: key }) });
    },
    onMutate: () => testDeepSeek.reset(),
    onSuccess: refreshAll,
  });
  const deleteDeepSeek = useMutation({
    mutationFn: async () => {
      const prepared = await apiFetch<{ nonce: string }>("/api/secrets/deepseek_api_key/prepare", { method: "POST", body: JSON.stringify({ action: "delete" }) });
      return apiFetch("/api/secrets/deepseek_api_key", { method: "DELETE", body: JSON.stringify({ nonce: prepared.nonce }) });
    },
    onSuccess: refreshAll,
  });

  const saveComplaintAutoSubmit = useMutation({
    mutationFn: (complaintAutoSubmit: boolean) => apiFetch<{ complaintAutoSubmit: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ complaintAutoSubmit }),
    }),
    onSettled: refreshAll,
  });

  const saveFeishu = useMutation({
    mutationFn: async () => {
      const secret = feishuSecret;
      setFeishuSecret("");
      await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ feishuAppId }) });
      if (secret) {
        const prepared = await apiFetch<{ nonce: string }>("/api/secrets/feishu_app_secret/prepare", { method: "POST", body: JSON.stringify({ action: "replace" }) });
        await apiFetch("/api/secrets/feishu_app_secret", { method: "PUT", body: JSON.stringify({ nonce: prepared.nonce, secret }) });
      }
    },
    onSuccess: refreshAll,
  });
  const testFeishu = useMutation({ mutationFn: () => apiFetch("/api/connections/feishu/test", { method: "POST" }), onSuccess: refreshAll });
  const deleteFeishu = useMutation({
    mutationFn: async () => {
      const prepared = await apiFetch<{ nonce: string }>("/api/secrets/feishu_app_secret/prepare", { method: "POST", body: JSON.stringify({ action: "delete" }) });
      await apiFetch("/api/secrets/feishu_app_secret", { method: "DELETE", body: JSON.stringify({ nonce: prepared.nonce }) });
      await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ feishuAppId: "" }) });
    },
    onSuccess: async () => { setFeishuAppId(""); await refreshAll(); },
  });

  const clearStoredData = useMutation({
    mutationFn: (segment: "reviews" | "locator-history" | "run-history") => apiFetch<{ deleted: number; storage: StorageState }>(`/api/storage/${segment}`, { method: "DELETE" }),
    onSuccess: (result) => queryClient.setQueryData(["storage"], result.storage),
  });
  const factoryReset = useMutation({
    mutationFn: async () => {
      const prepared = await apiFetch<{ nonce: string }>("/api/storage/factory-reset/prepare", { method: "POST" });
      return apiFetch<{ reset: true; storage: StorageState }>("/api/storage/factory-reset", { method: "POST", body: JSON.stringify({ nonce: prepared.nonce }) });
    },
    onSuccess: async (result) => {
      setAccount(""); setPassword(""); setDeepseekKey(""); setFeishuSecret(""); setFeishuAppId("");
      queryClient.clear();
      queryClient.setQueryData(["storage"], result.storage);
    },
  });

  function submitTmall(event: FormEvent) { event.preventDefault(); saveTmall.mutate(); }
  function submitDeepSeek(event: FormEvent) { event.preventDefault(); saveDeepSeek.mutate(); }
  function submitFeishu(event: FormEvent) { event.preventDefault(); saveFeishu.mutate(); }

  return (
    <section className="page-content settings-page">
      <div className="page-heading">
        <div><p className="eyebrow">账号与连接</p><h1>设置</h1><span>账号和密钥仅保存在这台电脑的 Windows 凭据管理器中，页面不会回显。</span></div>
        <StatusPill tone="success"><ShieldCheck size={13} />本机安全保存</StatusPill>
      </div>

      <article className="panel schedule-panel">
        <div className="panel-heading schedule-heading">
          <div><p className="eyebrow">运行计划</p><h3>自动回复时间</h3><span>每天可设置多个时间段，所有时间段共用同一个运行间隔。</span></div>
          <StatusPill tone={automationPlan.data?.paused ? "warning" : automationPlan.data?.enabled ? "success" : "neutral"}>{automationPlan.data?.paused ? "计划已暂停" : automationPlan.data?.enabled ? "计划已启用" : "计划未启用"}</StatusPill>
        </div>
        <div className="plan-summary-grid">
          <div><span>每日时间段</span><strong>{automationPlan.data?.windows.length ? automationPlan.data.windows.map((item) => `${item.start}—${item.end}`).join("、") : "未设置"}</strong></div>
          <div><span>运行间隔</span><strong>{automationPlan.data?.intervalMinutes ?? 15} 分钟</strong></div>
          <div><span>时区</span><strong>中国标准时间</strong></div>
        </div>
        <div className="schedule-actions">
          <Link className="button secondary" to="/"><CalendarClock size={16} />前往工作台修改</Link>
        </div>
      </article>

      <div className="connection-settings-grid">
        <article className="panel credential-card">
          <CredentialHeading icon={<ShieldCheck size={19} />} title="投诉提交" subtitle="仅处理已通过全部校验的投诉" configured={settings.data?.complaintAutoSubmit} />
          <div className="credential-form">
            <div className="complaint-auto-submit-setting" data-testid="complaint-auto-submit-control">
              <div className="complaint-auto-submit-copy">
                <strong>投诉自动提交</strong>
                <span>通过全部模型复核与事实校验后，才允许提交</span>
              </div>
              <label className="complaint-auto-submit-control">
                <span className="complaint-auto-submit-state">{settings.data?.complaintAutoSubmit ? "已开启" : "已关闭"}</span>
                <input
                  className="complaint-auto-submit-input"
                  aria-label="投诉自动提交"
                  type="checkbox"
                  checked={settings.data?.complaintAutoSubmit ?? false}
                  disabled={!settings.data || saveComplaintAutoSubmit.isPending}
                  onChange={(event) => saveComplaintAutoSubmit.mutate(event.target.checked)}
                />
              </label>
            </div>
            <p className="card-description">默认关闭；开启后仅对已通过全部校验的投诉自动提交。</p>
            <p className="auth-recheck-note">平台已明确处理、页面异常、提交结果不确定或证据不足时，系统仍会保留人工核对，不会重复投诉。</p>
            <ActionError errors={[saveComplaintAutoSubmit.error]} fallback="投诉自动提交设置保存失败，请稍后重试" />
            {saveComplaintAutoSubmit.isSuccess && <p className="inline-success"><CircleCheck size={16} />投诉自动提交设置已保存。</p>}
          </div>
        </article>

        <article className="panel credential-card featured-credential">
          <CredentialHeading icon={<LogIn size={19} />} title="淘宝商家登录" subtitle="用于掉线后重新登录并进入评价管理" ready={auth.data?.state === "authenticated"} configured={auth.data?.configured} />
          <form onSubmit={submitTmall} className="credential-form" autoComplete="off">
            <label className="field full"><span>淘宝商家账号</span><div className="input-with-icon"><input aria-label="淘宝商家账号" value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="off" placeholder={auth.data?.maskedAccount ?? "输入商家账号"} /><KeyRound size={17} /></div></label>
            <label className="field full"><span>淘宝商家密码</span><div className="input-with-icon"><input aria-label="淘宝商家密码" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" placeholder={auth.data?.configured ? "已保存；需要更换时重新输入" : "输入登录密码"} /><LockKeyhole size={17} /></div></label>
            <ActionError errors={[saveTmall.error, verifyTmall.error, deleteTmall.error]} fallback="淘宝登录操作失败，请稍后重试" />
            {auth.data?.configured && auth.data.state !== "authenticated" && auth.data.lastFailure && (
              <div className="inline-warning auth-guidance"><AlertTriangle size={16} /><span>{auth.data.lastFailure}</span></div>
            )}
            {shouldContinueExistingTmallSession && <p className="auth-recheck-note">完成验证码、短信验证或新手引导后，点击此按钮继续登录与页面检查。</p>}
            {(auth.data?.state === "authenticated" || saveTmall.data?.state === "authenticated" || verifyTmall.data?.state === "authenticated") && <p className="inline-success"><CircleCheck size={16} />登录已验证，可以开始处理评论。</p>}
            <div className="card-actions">
              <button className="button primary" type="submit" disabled={!account.trim() || !password || saveTmall.isPending}><ShieldCheck size={16} />{saveTmall.isPending ? "正在验证登录" : "保存并验证登录"}</button>
              {auth.data?.configured && <button className="button secondary" type="button" onClick={() => verifyTmall.mutate()} disabled={verifyTmall.isPending}><RefreshCw size={16} />{verifyTmall.isPending ? "正在检测淘宝窗口" : shouldContinueExistingTmallSession ? "已处理淘宝页面，重新检测" : "验证并进入评价页"}</button>}
            </div>
          </form>
          {auth.data?.configured && <button className="quiet-danger" type="button" onClick={() => deleteTmall.mutate()}><Trash2 size={15} />退出并清除淘宝登录数据</button>}
        </article>

        <article className="panel credential-card">
          <CredentialHeading icon={<Bot size={19} />} title="DeepSeek" subtitle="用于评论分类和产品信息修正" configured={settings.data?.deepseekApiKeyConfigured} />
          <form onSubmit={submitDeepSeek} className="credential-form" autoComplete="off">
            <label className="field full"><span>DeepSeek API Key</span><div className="input-with-icon"><input aria-label="DeepSeek API Key" value={deepseekKey} onChange={(event) => setDeepseekKey(event.target.value)} type="password" autoComplete="new-password" placeholder={settings.data?.deepseekApiKeyConfigured ? "已保存；留空不会更换" : "输入 API Key"} /><LockKeyhole size={17} /></div></label>
            <div className="model-note"><span>全部处理</span><strong>V4 Pro</strong></div>
            <ActionError errors={[saveDeepSeek.error, testDeepSeek.error, deleteDeepSeek.error]} fallback="DeepSeek 保存失败，请稍后重试" />
            {saveDeepSeek.isSuccess && <p className="inline-success"><CircleCheck size={16} />DeepSeek 已保存，待验证。</p>}
            {testDeepSeek.data && <>
              {testDeepSeek.data.status === "ready"
                ? <p className="inline-success"><CircleCheck size={16} />Pro 已验证。</p>
                : <p className="inline-warning"><AlertTriangle size={16} />DeepSeek Pro 验证未通过。</p>}
              {testDeepSeek.data.checks && <div className="model-note" role="status">
                <span>{deepSeekCheckText("Pro", testDeepSeek.data.checks.pro)}</span>
              </div>}
            </>}
            <div className="card-actions">
              <button className="button primary" type="submit" disabled={!deepseekKey || saveDeepSeek.isPending}><ShieldCheck size={16} />保存 DeepSeek</button>
              <button className="button secondary" type="button" onClick={() => testDeepSeek.mutate()} disabled={!settings.data?.deepseekApiKeyConfigured || testDeepSeek.isPending}><RefreshCw size={16} />测试 DeepSeek</button>
            </div>
          </form>
          {settings.data?.deepseekApiKeyConfigured && <button className="quiet-danger" type="button" onClick={() => deleteDeepSeek.mutate()}><Trash2 size={15} />删除 API Key</button>}
        </article>

        <article className="panel credential-card">
          <CredentialHeading icon={<Database size={19} />} title="飞书应用" subtitle="只读同步好评和差评话术库" configured={settings.data?.feishuAppSecretConfigured && Boolean(settings.data?.feishuAppId)} />
          <form onSubmit={submitFeishu} className="credential-form" autoComplete="off">
            <label className="field full"><span>飞书 App ID</span><div className="input-with-icon"><input aria-label="飞书 App ID" value={feishuAppId} onChange={(event) => setFeishuAppId(event.target.value)} autoComplete="off" placeholder="cli_xxxxxxxxxxxxx" /><KeyRound size={17} /></div></label>
            <label className="field full"><span>飞书 App Secret</span><div className="input-with-icon"><input aria-label="飞书 App Secret" value={feishuSecret} onChange={(event) => setFeishuSecret(event.target.value)} type="password" autoComplete="new-password" placeholder={settings.data?.feishuAppSecretConfigured ? "已保存；留空不会更换" : "输入 App Secret"} /><LockKeyhole size={17} /></div></label>
            <ActionError errors={[saveFeishu.error, testFeishu.error, deleteFeishu.error]} fallback="飞书设置操作失败，请稍后重试" />
            {saveFeishu.isSuccess && <p className="inline-success"><CircleCheck size={16} />飞书应用凭据已保存。</p>}
            {testFeishu.isSuccess && <p className="inline-success"><CircleCheck size={16} />飞书连接正常。</p>}
            <div className="card-actions">
              <button className="button primary" type="submit" disabled={!feishuAppId.trim() || saveFeishu.isPending}><ShieldCheck size={16} />保存飞书凭据</button>
              <button className="button secondary" type="button" onClick={() => testFeishu.mutate()} disabled={!settings.data?.feishuAppSecretConfigured || testFeishu.isPending}><RefreshCw size={16} />测试飞书</button>
            </div>
          </form>
          <Link className="inline-link" to="/templates">填写两个话术库链接 <ChevronRight size={15} /></Link>
          {settings.data?.feishuAppSecretConfigured && <button className="quiet-danger" type="button" onClick={() => deleteFeishu.mutate()}><Trash2 size={15} />删除飞书应用凭据</button>}
        </article>
      </div>

      <details className="advanced-settings">
        <summary><span><Wrench size={17} />高级设置与诊断</span><small>日常使用不需要打开</small></summary>
        <div className="advanced-grid">
          <article className="panel compact-panel storage-panel">
            <div className="panel-heading"><div><p className="eyebrow">数据管理</p><h3>存储与自动清理</h3></div><strong>{formatBytes(storage.data?.usedBytes ?? 0)}</strong></div>
            <p className="card-description">评论与处理结果保留90天，回复提交记录保留180天，页面修复记录保留30天，页面检查记录保留7天。当前计划、待核对提交、正在使用的话术和凭据不会被日常清理。</p>
            <div className="storage-counts">
              <Parameter label="评论记录" value={`${storage.data?.counts?.reviews ?? 0} 条`} />
              <Parameter label="回复提交记录" value={`${storage.data?.counts?.submissionAudit ?? 0} 条`} />
              <Parameter label="自动跳过商品" value={`${storage.data?.counts?.manualProducts ?? 0} 条`} />
              <Parameter label="已自动跳过评价" value={`${storage.data?.counts?.manualHolds ?? 0} 条`} />
              <Parameter label="防重复处理记录" value={`${storage.data?.counts?.actionTombstones ?? 0} 条`} />
              <Parameter label="修复记录" value={`${storage.data?.counts?.locatorRepairs ?? 0} 条`} />
              <Parameter label="页面检查记录" value={`${storage.data?.counts?.locatorSnapshots ?? 0} 条`} />
              <Parameter label="运行记录" value={`${storage.data?.counts?.runs ?? 0} 条`} />
              <Parameter label="浏览器登录数据" value={formatBytes(storage.data?.browserProfileBytes ?? 0)} />
            </div>
            <ActionError errors={[clearStoredData.error, factoryReset.error]} fallback="数据管理操作失败，请稍后重试" />
            {clearStoredData.isSuccess && <p className="inline-success"><CircleCheck size={16} />已清理 {clearStoredData.data.deleted} 条记录。</p>}
            <div className="storage-actions">
              <button className="button secondary" type="button" onClick={() => clearStoredData.mutate("reviews")} disabled={clearStoredData.isPending}>清理历史评论</button>
              <button className="button secondary" type="button" onClick={() => clearStoredData.mutate("locator-history")} disabled={clearStoredData.isPending}>清理修复记录</button>
              <button className="button secondary" type="button" onClick={() => clearStoredData.mutate("run-history")} disabled={clearStoredData.isPending}>清理运行记录</button>
            </div>
            <div className="factory-reset-row"><div><strong>恢复出厂设置</strong><span>恢复出厂设置会清空自动跳过商品名单和处理日期，并删除本机的账号凭据、话术缓存、运行记录和浏览器登录数据。此操作不可撤销。</span></div><button className="quiet-danger" type="button" disabled={factoryReset.isPending} onClick={() => { if (window.confirm("确定恢复出厂设置吗？自动跳过商品名单、处理日期、账号、密钥、话术缓存和处理记录都会被删除。")) factoryReset.mutate(); }}><Trash2 size={15} />{factoryReset.isPending ? "正在清除" : "恢复出厂设置"}</button></div>
          </article>
          <Link className="diagnostic-link" to="/health"><span><Wrench size={18} /></span><div><strong>自动修复与页面诊断</strong><small>仅在淘宝页面结构变化、程序提示无法定位时使用</small></div><ChevronRight size={18} /></Link>
        </div>
      </details>
    </section>
  );
}

function CredentialHeading({ icon, title, subtitle, ready, configured }: { icon: React.ReactNode; title: string; subtitle: string; ready?: boolean | undefined; configured?: boolean | undefined }) {
  return <div className="credential-heading"><span className="credential-icon">{icon}</span><div><h3>{title}</h3><p>{subtitle}</p></div><StatusPill tone={ready ? "success" : configured ? "neutral" : "warning"}>{ready ? "已登录" : configured ? "已配置" : "未配置"}</StatusPill></div>;
}

function ActionError({ errors, fallback }: { errors: Array<Error | null>; fallback: string }) {
  const error = errors.find(Boolean);
  return error ? <div className="inline-warning"><AlertTriangle size={16} />{toUserMessage(error, fallback)}</div> : null;
}

function Parameter({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
