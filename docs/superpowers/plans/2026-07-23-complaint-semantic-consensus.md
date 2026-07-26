# Complaint Semantic Consensus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute this plan task-by-task. This task is executed inline because the user explicitly prohibited agents.

**Goal:** Relax unstable quote-boundary equality while adding conservative text-only evidence for complaint types that can be proven from review text.

**Architecture:** Keep independent tracked model invocations and compare their semantic identity (`complaintType` plus `factCode`). Validate every confirmation against its own tracked invocation. Extend the deterministic review-text fact mapper without changing browser submission safety.

**Tech Stack:** TypeScript, Vitest, Fastify service/domain modules.

---

### Task 1: Semantic confirmation identity

**Files:**
- Modify: `apps/server/src/complaints/complaint-domain.ts`
- Modify: `apps/server/src/complaints/complaint-domain.test.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.test.ts`

- [ ] Add failing tests for equal type/fact with different quote spans.
- [ ] Run the focused tests and confirm the expected failure.
- [ ] Validate each confirmation against its own tracked invocation and compare semantic identity for consensus.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Conservative text-only facts

**Files:**
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.test.ts`

- [ ] Add failing positive and exclusion tests for text-verifiable complaint types.
- [ ] Run the focused tests and confirm the expected failure.
- [ ] Implement minimal deterministic fact extraction.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Verification

**Files:**
- Verify only.

- [ ] Run all complaint tests.
- [ ] Run all server tests.
- [ ] Run repository type checks.
- [ ] Run repository build.
- [ ] Inspect the final diff without modifying unrelated working-tree changes.
