import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";
import { buildApp } from "../../apps/server/src/app";
import { InMemorySecretStore } from "../../apps/server/src/security/credential-store";
import { openDatabase, runMigrations } from "../../apps/server/src/storage/database";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default async function globalSetup() {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO reply_drafts(
      id, source_key, order_id, review_text, product_title, reviewed_at, sentiment_label,
      library, primary_category, category, classification_confidence, classification_reason,
      template_sequence, original_template, final_reply, product_adjusted, rewrite_notes,
      attention_reasons_json, state, discovered_at, processed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "e2e-draft-1",
    "tmall:e2e:review-1",
    "3309081924709001",
    "音质还可以，但是戴着有点夹耳朵",
    "漫步者 X1 EVO 真无线蓝牙耳机",
    "2026-07-14 08:00",
    "positive",
    "bad",
    "佩戴体验",
    "佩戴体验",
    0.91,
    "买家明确反馈夹耳朵",
    2,
    "非常抱歉给您带来不适的佩戴体验。",
    "非常抱歉给您带来不适的佩戴体验，建议调整 X1 EVO 的佩戴角度。若使用过程中有任何疑问可咨询漫步者客服，祝您生活愉快！",
    1,
    "已将模板中的产品指代改为当前商品",
    JSON.stringify(["页面标记为正面评价，但评论内容被识别为差评"]),
    "needs_attention",
    now,
    now,
    now,
  );

  const api = buildApp({
    host: "127.0.0.1:4310",
    origin: "http://127.0.0.1:5183",
    sessionToken: randomBytes(32).toString("hex"),
    csrfToken: randomBytes(32).toString("hex"),
    database,
    secretStore: new InMemorySecretStore(),
    tmallAuthDriver: {
      canSubmitReplies: true,
      openReviewPage: async () => ({ state: "authenticated", storeName: "e2e-merchant-account", page: "review_list" }),
      readPendingReviews: async () => [],
      readPendingReviewPage: async () => [],
      submitReply: async () => ({ state: "sent", evidence: "评价列表显示已回复" }),
      verifyCriticalElements: async () => ({
        verifiedOperationKeys: ["navigation.trade", "navigation.reviews", "review.filter.content", "review.filter.unanswered", "review.list", "review.product", "reply.open", "reply.editor", "reply.submit"],
        missingOperationKeys: [],
      }),
      close: async () => undefined,
      clearProfile: async () => undefined,
    },
  });

  await api.listen({ host: "127.0.0.1", port: 4310 });
  try {
    const web = await createServer({
      root: resolve(root, "apps/web"),
      configFile: resolve(root, "apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 5183,
        strictPort: true,
        proxy: { "/api": { target: "http://127.0.0.1:4310", changeOrigin: true } },
      },
    });
    await web.listen();

    return async () => {
      await web.close();
      await api.close();
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}
