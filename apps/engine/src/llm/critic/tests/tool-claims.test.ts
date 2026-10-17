import { describe, expect, it } from "bun:test";
import type { ToolResult } from "../../../conversations/tools/index.ts";
import { normalizeToolResultPayload } from "../../../conversations/tools/result-payload.ts";
import { runCritic, summarizeToolResult } from "../index.ts";
import { detectToolClaimMismatches } from "../tool-claims.ts";

function candidateId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function rejectToolResult(rejected: number, notFound: number, alreadyDecided = 0): ToolResult {
  const results = [
    ...Array.from({ length: rejected }, (_, i) => ({
      candidate_id: candidateId(i + 1),
      outcome: "rejected",
    })),
    ...Array.from({ length: notFound }, (_, i) => ({
      candidate_id: candidateId(rejected + i + 1),
      outcome: "not_found",
    })),
    ...Array.from({ length: alreadyDecided }, (_, i) => ({
      candidate_id: candidateId(rejected + notFound + i + 1),
      outcome: "already_decided",
    })),
  ];
  const data = { results, rejected, not_found: notFound, already_decided: alreadyDecided };
  if (rejected > 0) return { ok: true, data };
  const error = notFound > 0 ? "not_found" : "already_decided";
  return {
    ok: false,
    error_code: error,
    message: "Nothing was rejected.",
    data: { ...data, error },
  };
}

function batchRejectOutput(rejected: number, notFound: number, alreadyDecided = 0): unknown {
  return normalizeToolResultPayload(rejectToolResult(rejected, notFound, alreadyDecided));
}

function precheckRefusalOutput(notFound: string[], alreadyDecided: string[]): unknown {
  const error = notFound.length > 0 ? "not_found" : "already_decided";
  return normalizeToolResultPayload({
    ok: false,
    error_code: error,
    message: "Nothing ran.",
    data: { error, not_found: notFound, already_decided: alreadyDecided, message: "Nothing ran." },
    next_best_actions: ["list_skill_candidates"],
  });
}

function failedApproveOutput(error: "not_found" | "already_decided" | "changed_since_review") {
  return normalizeToolResultPayload({
    ok: false,
    error_code: error,
    message: "Nothing was approved.",
    data: { error, message: "Nothing was approved." },
  });
}

describe("summarizeToolResult", () => {
  it("reads batch outcome counts and only successful ids as processed", () => {
    const summary = summarizeToolResult("reject_skill_candidate", batchRejectOutput(1, 2, 1));
    expect(summary.ok).toBe(true);
    expect(summary.outcomes).toEqual({ rejected: 1, not_found: 2, already_decided: 1 });
    expect(summary.ids).toHaveLength(4);
    expect(summary.processed_ids).toEqual([candidateId(1)]);
  });

  it("marks an error payload as failed and records the error", () => {
    const summary = summarizeToolResult(
      "approve_skill_candidate",
      failedApproveOutput("changed_since_review"),
    );
    expect(summary.ok).toBe(false);
    expect(summary.error).toBe("changed_since_review");
    expect(summary.outcomes).toEqual({});
    expect(summary.processed_ids).toEqual([]);
  });

  it("counts a successful single approve as one approval", () => {
    const summary = summarizeToolResult("approve_skill_candidate", {
      candidate: { id: candidateId(7), status: "approved" },
      skill_id: candidateId(8),
      skill_status: "draft",
    });
    expect(summary.ok).toBe(true);
    expect(summary.outcomes).toEqual({ approved: 1 });
    expect(summary.processed_ids).toContain(candidateId(7));
  });

  it("reads a single result kind", () => {
    const summary = summarizeToolResult("reject_skill_candidate", { kind: "not_found" });
    expect(summary.outcomes).toEqual({ not_found: 1 });
  });
});

describe("chat critic claim check against tool results", () => {
  it("passes when the claimed rejection count equals the batch result", async () => {
    const v = await runCritic({
      artifact: { kind: "chat", payload: "Erledigt: Ich habe 45 Vorschläge verworfen." },
      toolResults: [summarizeToolResult("reject_skill_candidate", batchRejectOutput(45, 0))],
    });
    expect(v.verdict).toBe("pass");
    expect(v.checks?.tool_counts_match).toBe(true);
    expect(v.checks?.no_success_after_failure).toBe(true);
    expect(v.checks?.processed_ids_in_results).toBe(true);
  });

  it("fails when the text claims more removals than were rejected", async () => {
    const v = await runCritic({
      artifact: { kind: "chat", payload: "4 Duplikate entfernt." },
      toolResults: [summarizeToolResult("reject_skill_candidate", batchRejectOutput(1, 1, 2))],
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.tool_counts_match).toBe(false);
    expect(v.hint).toContain("text claims 4 rejected");
    expect(v.hint).toContain("rejected=1, not_found=1, already_decided=2");
  });

  it("fails when removals are claimed after the precheck refused the batch", async () => {
    const v = await runCritic({
      artifact: { kind: "chat", payload: "4 Duplikate entfernt." },
      toolResults: [
        summarizeToolResult(
          "reject_skill_candidate",
          precheckRefusalOutput([candidateId(1)], [candidateId(2), candidateId(3)]),
        ),
      ],
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.tool_counts_match).toBe(false);
    expect(v.checks?.no_success_after_failure).toBe(false);
    expect(v.hint).toContain("reject_skill_candidate returned ok:false (not_found)");
  });

  it("fails when removals are claimed after every confirmed id changed", async () => {
    const v = await runCritic({
      artifact: { kind: "chat", payload: "2 Vorschläge verworfen." },
      toolResults: [summarizeToolResult("reject_skill_candidate", batchRejectOutput(0, 0, 2))],
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.no_success_after_failure).toBe(false);
    expect(v.hint).toContain("already_decided");
  });

  it("fails when approval wording follows a failed approve", async () => {
    const v = await runCritic({
      artifact: { kind: "chat", payload: "Der Vorschlag wurde genehmigt." },
      toolResults: [
        summarizeToolResult("approve_skill_candidate", failedApproveOutput("already_decided")),
      ],
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.no_success_after_failure).toBe(false);
    expect(v.hint).toContain("approve_skill_candidate returned ok:false");
    expect(v.hint).toContain("already_decided");
  });

  it("accepts an honest report of the failed approve", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "Der Vorschlag wurde nicht genehmigt, er war bereits entschieden.",
      },
      toolResults: [
        summarizeToolResult("approve_skill_candidate", failedApproveOutput("already_decided")),
      ],
    });
    expect(v.verdict).toBe("pass");
  });

  it("accepts a later successful retry of the same tool", () => {
    const issues = detectToolClaimMismatches("Der Vorschlag wurde genehmigt.", [
      summarizeToolResult("approve_skill_candidate", { error: "transient" }),
      summarizeToolResult("approve_skill_candidate", {
        candidate: { id: candidateId(7) },
        skill_id: candidateId(8),
      }),
    ]);
    expect(issues).toEqual([]);
  });

  it("fails when an id reported as rejected was not found", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: `Kandidat ${candidateId(3)} wurde verworfen.`,
      },
      snapshot: "tenant snapshot",
      toolResults: [summarizeToolResult("reject_skill_candidate", batchRejectOutput(1, 3))],
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.processed_ids_in_results).toBe(false);
    expect(v.checks?.ids_grounded).toBe(true);
    expect(v.hint).toContain(candidateId(3));
  });

  it("treats ids returned by tool results as grounded", async () => {
    const v = await runCritic({
      artifact: { kind: "chat", payload: `Kandidat ${candidateId(1)} wurde verworfen.` },
      snapshot: "tenant snapshot",
      toolResults: [summarizeToolResult("reject_skill_candidate", batchRejectOutput(1, 3))],
    });
    expect(v.verdict).toBe("pass");
  });

  it("does not read the denominator of a partial count as a claim", () => {
    const issues = detectToolClaimMismatches(
      "Von 4 Duplikaten wurde 1 verworfen; 3 waren nicht mehr offen.",
      [summarizeToolResult("reject_skill_candidate", batchRejectOutput(1, 3))],
    );
    expect(issues).toEqual([]);
  });

  it("ignores conditional wording before confirmation", () => {
    const issues = detectToolClaimMismatches(
      "Sobald du bestätigst, werden 45 Vorschläge verworfen.",
      [summarizeToolResult("reject_skill_candidate", { error_code: "policy_confirm_required" })],
    );
    expect(issues).toEqual([]);
  });

  it("skips claim checks when no tool results are passed", async () => {
    const v = await runCritic({ artifact: { kind: "chat", payload: "4 Duplikate entfernt." } });
    expect(v.verdict).toBe("pass");
    expect(v.checks?.tool_counts_match).toBeUndefined();
  });

  it("skips a claim class with no matching tool result", () => {
    const issues = detectToolClaimMismatches("12 Einträge wurden genehmigt.", [
      summarizeToolResult("search_knowledge", { hits: [] }),
    ]);
    expect(issues).toEqual([]);
  });
});
