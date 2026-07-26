import { describe, expect, it } from "vitest";
import { PERSISTED_DATA_TYPES, RETENTION_POLICIES } from "./retention";

describe("retention policy catalogue", () => {
  it("declares lifecycle and cleanup metadata for every persisted data type", () => {
    expect(Object.keys(RETENTION_POLICIES).sort()).toEqual([...PERSISTED_DATA_TYPES].sort());

    for (const type of PERSISTED_DATA_TYPES) {
      const policy = RETENTION_POLICIES[type];
      expect(policy.label.length).toBeGreaterThan(0);
      expect(["automatic", "manual", "factory_reset_only"]).toContain(policy.cleanup);
      expect(["exportable", "redacted_only", "never"]).toContain(policy.export);
      expect(policy.retentionDays === null || policy.retentionDays > 0).toBe(true);
    }
  });

  it("never exports credentials, browser data, or identity salt", () => {
    expect(RETENTION_POLICIES.secrets.export).toBe("never");
    expect(RETENTION_POLICIES.browser_profile.export).toBe("never");
    expect(RETENTION_POLICIES.identity_salt.export).toBe("never");
  });

  it("matches the formal product retention windows", () => {
    expect(RETENTION_POLICIES.reviews.retentionDays).toBe(90);
    expect(RETENTION_POLICIES.complaints.retentionDays).toBe(90);
    expect(RETENTION_POLICIES.manual_holds.retentionDays).toBe(90);
    expect(RETENTION_POLICIES.audit.retentionDays).toBe(180);
    expect(RETENTION_POLICIES.complaint_audit.retentionDays).toBe(180);
    expect(RETENTION_POLICIES.action_tombstones.retentionDays).toBe(180);
    expect(RETENTION_POLICIES.locator_history.retentionDays).toBe(30);
    expect(RETENTION_POLICIES.redacted_snapshots.retentionDays).toBe(7);
  });

  it("keeps operator rules outside ordinary age-based cleanup", () => {
    expect(RETENTION_POLICIES.review_scope).toMatchObject({ retentionDays: null, cleanup: "manual" });
    expect(RETENTION_POLICIES.manual_products).toMatchObject({ retentionDays: null, cleanup: "manual" });
    expect(RETENTION_POLICIES.template_cache.retentionDays).toBeNull();
  });
});
