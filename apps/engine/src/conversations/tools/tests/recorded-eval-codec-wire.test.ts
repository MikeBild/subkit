import { describe, expect, test } from "bun:test";
import { MISSING_EVIDENCE_NEXT_ACTIONS, runRecordedEval } from "../../recorded-eval.ts";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

describe("runRecordedEval — hand-rolled-codec block next-action wire shape", () => {
  test("CODEC_REWRITE is the documented wire literal", () => {
    expect(MISSING_EVIDENCE_NEXT_ACTIONS.CODEC_REWRITE).toBe("rewrite_with_sk_base64");
  });

  test("a codec-only failure surfaces the codec-rewrite next-action constant", async () => {
    const report = await runRecordedEval(
      {
        steps: [
          {
            id: "encode",
            kind: "transform",
            language: "javascript",
            expression: `const A = "${B64_ALPHABET}"; let out = ""; for (let i = 0; i < input.input.length; i++) out += A[i % 64]; return out;`,
          },
        ],
      },
      { latest_preview: null },
    );

    expect(report.gates.transform.ok).toBe(false);
    expect(report.gates.transform.blocks).toHaveLength(1);
    expect(report.gates.transform.blocks[0]?.reason).toBe("hand_rolled_codec_alphabet");
    expect(report.ok).toBe(false);

    const codecEntry = report.missing_evidence.find((m) => m.step_id === "encode");
    expect(codecEntry).toBeDefined();
    expect(codecEntry?.next_action).toBe(MISSING_EVIDENCE_NEXT_ACTIONS.CODEC_REWRITE);
    expect(codecEntry?.next_action).not.toBe(MISSING_EVIDENCE_NEXT_ACTIONS.PREVIEW_GAP);

    expect(report.next_actions).toContain("edit_workflow_patch");
    expect(report.next_actions).toContain("edit_workflow_patch");
    expect(report.next_actions).not.toContain("dry_run_workflow");
  });
});

describe("MissingEvidenceNextActionSchema — runtime guard at the wire boundary", () => {
  test("accepts the two canonical next-actions", async () => {
    const { MissingEvidenceNextActionSchema, MISSING_EVIDENCE_NEXT_ACTIONS } = await import(
      "../../recorded-eval.ts"
    );
    expect(MissingEvidenceNextActionSchema.parse(MISSING_EVIDENCE_NEXT_ACTIONS.PREVIEW_GAP)).toBe(
      "dry_run_workflow",
    );
    expect(MissingEvidenceNextActionSchema.parse(MISSING_EVIDENCE_NEXT_ACTIONS.CODEC_REWRITE)).toBe(
      "rewrite_with_sk_base64",
    );
  });

  test("rejects an unknown next-action (the gap the bare TS union left open)", async () => {
    const { MissingEvidenceNextActionSchema, RecordedEvalMissingEvidenceSchema } = await import(
      "../../recorded-eval.ts"
    );
    expect(MissingEvidenceNextActionSchema.safeParse("inspect_workflow_draft").success).toBe(false);
    expect(
      RecordedEvalMissingEvidenceSchema.safeParse({
        step_id: "s1",
        reason: "x",
        next_action: "not_a_real_action",
      }).success,
    ).toBe(false);
  });
});
