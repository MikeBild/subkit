// Pure unit tests for per-id 8-char SHA-256 hash determinism and the
// recordLlmContextAssembled structured log line shape.
//
// No DB, no Docker. Spies on the logRing to assert log content.
// Decision 1: per-id hashes are grep-able, bounded to ≤ 12 entries,
// and no metric labels carry raw hash values (cardinality protection).

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { idHashesCapped } from "../id-hashes.ts";
import { recordLlmContextAssembled } from "../instrumentation.ts";
import { logRing } from "../log-ring.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "../metrics.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

function callRecordLlmContextAssembled(overrides: {
  included_skill_id_hashes?: string[];
  included_candidate_id_hashes?: string[];
  included_recipe_slug_hashes?: string[];
  included?: {
    skills?: number;
    knowledge?: number;
    docs?: number;
    failures?: number;
    recipes_bodies?: number;
    candidates?: number;
  };
}): void {
  recordLlmContextAssembled({
    tenant_id: "test-tenant-id",
    flow: "converse",
    model: "claude-haiku-4-5",
    cap_tokens: 180_000,
    total_tokens: 5000,
    stable_tokens: 3000,
    volatile_tokens: 2000,
    messages_tokens: 500,
    included: {
      skills: overrides.included?.skills ?? 0,
      knowledge: overrides.included?.knowledge ?? 0,
      docs: overrides.included?.docs ?? 0,
      failures: overrides.included?.failures ?? 0,
      recipes_bodies: overrides.included?.recipes_bodies ?? 0,
      candidates: overrides.included?.candidates ?? 0,
    },
    included_skill_id_hashes: overrides.included_skill_id_hashes ?? [],
    included_candidate_id_hashes: overrides.included_candidate_id_hashes ?? [],
    included_recipe_slug_hashes: overrides.included_recipe_slug_hashes ?? [],
    dropped_sections: [],
  });
}

// ---------------------------------------------------------------------------
// Hash function determinism
// ---------------------------------------------------------------------------

describe("per-id 8-char SHA-256 hash determinism", () => {
  test("same id always produces the same 8-char hash", () => {
    const id = "skill-candidate-uuid-abc123";
    const h1 = hashId(id);
    const h2 = hashId(id);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(8);
    // Must be lowercase hex characters only
    expect(/^[0-9a-f]{8}$/.test(h1)).toBe(true);
  });

  test("different ids produce different hashes (collision-free for small set)", () => {
    const ids = [
      "skill-abc",
      "skill-def",
      "candidate-123",
      "recipe-stripe-charge",
      "recipe-slack-notify",
    ];
    const hashes = ids.map(hashId);
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(ids.length);
  });

  test("hash is stable across multiple calls in the same process", () => {
    const testId = "connector-template-stripe";
    const first = hashId(testId);
    for (let i = 0; i < 10; i++) {
      expect(hashId(testId)).toBe(first);
    }
  });

  test("empty string id produces a valid 8-char hash", () => {
    const h = hashId("");
    expect(h).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(h)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decision 1: lists capped at 12 entries in log line
// ---------------------------------------------------------------------------

describe("recordLlmContextAssembled — log line hash arrays capped at 12", () => {
  afterEach(() => {
    logRing.clear();
    resetMetricsRegistryForTests();
  });

  test("up to 12 skill id hashes all appear in the log entry", () => {
    const hashes = Array.from({ length: 12 }, (_, i) => hashId(`skill-${i}`));
    callRecordLlmContextAssembled({
      included_skill_id_hashes: hashes,
      included: { skills: 12 },
    });

    const entries = logRing.tail({ action: "context.assembled", limit: 5 });
    expect(entries.length).toBeGreaterThan(0);
    const lastEntry = entries[0]!;
    const fieldHashes = lastEntry.fields.included_skill_id_hashes as string[];
    expect(Array.isArray(fieldHashes)).toBe(true);
    expect(fieldHashes).toHaveLength(12);
    for (const h of hashes) {
      expect(fieldHashes).toContain(h);
    }
  });

  test("candidate id hashes appear in log entry", () => {
    const hashes = [hashId("cand-a"), hashId("cand-b")];
    callRecordLlmContextAssembled({
      included_candidate_id_hashes: hashes,
      included: { candidates: 2 },
    });

    const entries = logRing.tail({ action: "context.assembled", limit: 5 });
    const lastEntry = entries[0]!;
    const fieldHashes = lastEntry.fields.included_candidate_id_hashes as string[];
    expect(fieldHashes).toHaveLength(2);
    expect(fieldHashes).toContain(hashId("cand-a"));
  });

  test("recipe slug hashes appear in log entry", () => {
    const hashes = [hashId("stripe-charge-succeeded"), hashId("slack-notify")];
    callRecordLlmContextAssembled({
      included_recipe_slug_hashes: hashes,
      included: { recipes_bodies: 2 },
    });

    const entries = logRing.tail({ action: "context.assembled", limit: 5 });
    const lastEntry = entries[0]!;
    const fieldHashes = lastEntry.fields.included_recipe_slug_hashes as string[];
    expect(fieldHashes).toHaveLength(2);
    expect(fieldHashes).toContain(hashId("stripe-charge-succeeded"));
  });

  test("all three hash arrays + new counts present in log line", () => {
    const skillHashes = [hashId("skill-1"), hashId("skill-2")];
    const candidateHashes = [hashId("cand-1")];
    const recipeHashes = [hashId("recipe-1"), hashId("recipe-2"), hashId("recipe-3")];

    callRecordLlmContextAssembled({
      included_skill_id_hashes: skillHashes,
      included_candidate_id_hashes: candidateHashes,
      included_recipe_slug_hashes: recipeHashes,
      included: {
        skills: 2,
        candidates: 1,
        recipes_bodies: 3,
        knowledge: 4,
        docs: 2,
        failures: 0,
      },
    });

    const entries = logRing.tail({ action: "context.assembled", limit: 5 });
    expect(entries.length).toBeGreaterThan(0);
    const lastEntry = entries[0]!;
    const f = lastEntry.fields;

    // All three hash arrays
    expect(Array.isArray(f.included_skill_id_hashes)).toBe(true);
    expect(Array.isArray(f.included_candidate_id_hashes)).toBe(true);
    expect(Array.isArray(f.included_recipe_slug_hashes)).toBe(true);

    // New included counts
    expect(f.included_recipes_bodies).toBe(3);
    expect(f.included_candidates).toBe(1);
  });

  test("no metric label carries a hash value (cardinality protection)", () => {
    const hashes = Array.from({ length: 5 }, (_, i) => hashId(`skill-${i}`));
    callRecordLlmContextAssembled({ included_skill_id_hashes: hashes });

    const snap = getMetrics().snapshot();
    // Walk all series samples — ensure no label value matches any of the hashes
    for (const series of snap) {
      for (const sample of series.samples) {
        for (const labelValue of Object.values(sample.labels)) {
          for (const hash of hashes) {
            expect(labelValue).not.toBe(hash);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Log line correctness
// ---------------------------------------------------------------------------

describe("recordLlmContextAssembled — structured log line", () => {
  afterEach(() => {
    logRing.clear();
    resetMetricsRegistryForTests();
  });

  test("log line is at info level with module=llm action=context.assembled", () => {
    callRecordLlmContextAssembled({});

    const entries = logRing.tail({ action: "context.assembled", limit: 5 });
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[0]!;
    expect(last.level).toBe("info");
    expect(last.module).toBe("llm");
    expect(last.action).toBe("context.assembled");
  });

  test("log line includes tenant_id + flow + model fields", () => {
    callRecordLlmContextAssembled({});

    const entries = logRing.tail({ action: "context.assembled", limit: 5 });
    const last = entries[0]!;
    expect(last.fields.tenant_id).toBe("test-tenant-id");
    expect(last.fields.flow).toBe("converse");
    expect(last.fields.model).toBe("claude-haiku-4-5");
  });

  test("log line includes token budget fields", () => {
    callRecordLlmContextAssembled({});

    const entries = logRing.tail({ action: "context.assembled", limit: 5 });
    const last = entries[0]!;
    expect(last.fields.cap_tokens).toBe(180_000);
    expect(last.fields.total_tokens).toBe(5000);
    expect(last.fields.stable_tokens).toBe(3000);
    expect(last.fields.volatile_tokens).toBe(2000);
    expect(last.fields.messages_tokens).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// idHashesCapped — boundary behaviour (cap at 12)
// ---------------------------------------------------------------------------

describe("idHashesCapped — list capped at 12 regardless of input size", () => {
  test("input ≤ 12 ids: every id is hashed; output length matches input", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `id-${i}`);
    const hashes = idHashesCapped(ids);
    expect(hashes).toHaveLength(5);
    for (let i = 0; i < ids.length; i++) {
      expect(hashes[i]).toBe(hashId(ids[i]!));
    }
  });

  test("input = 12 ids: every id is hashed (boundary)", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const hashes = idHashesCapped(ids);
    expect(hashes).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      expect(hashes[i]).toBe(hashId(ids[i]!));
    }
  });

  test("input > 12 ids: output truncated to 12; only the first 12 ids hashed", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    const hashes = idHashesCapped(ids);
    expect(hashes).toHaveLength(12);
    // First 12 ids' hashes appear in order
    for (let i = 0; i < 12; i++) {
      expect(hashes[i]).toBe(hashId(ids[i]!));
    }
    // Ids 12-19 must NOT appear in the output
    for (let i = 12; i < 20; i++) {
      expect(hashes).not.toContain(hashId(ids[i]!));
    }
  });

  test("custom cap parameter is honored", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id-${i}`);
    expect(idHashesCapped(ids, 3)).toHaveLength(3);
    expect(idHashesCapped(ids, 100)).toHaveLength(10);
    expect(idHashesCapped([], 12)).toHaveLength(0);
  });
});
