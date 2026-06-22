// Wire-shape pin for the hand-rolled-codec next-action. When a
// hand-rolled-codec block is the ONLY failure in a draft, `runRecordedEval`
// must surface the codec-rewrite next-action wire value that downstream
// tools/clients depend on. The literal lives in one typed const map
// (`MISSING_EVIDENCE_NEXT_ACTIONS`); this test asserts the report emits that
// exact constant so a refactor that renames or reshapes it is caught:
//   - the `missing_evidence` entry for the codec step carries
//     `next_action === MISSING_EVIDENCE_NEXT_ACTIONS.CODEC_REWRITE`
//   - the top-level `next_actions` array steers to `update_param` +
//     `edit_workflow_patch` (the codec fix is a source rewrite, NOT a
//     dry_run_workflow)
//
// A single transform step whose source embeds the sequential base64
// alphabet — with NO `$scope`/`input.scope` sibling references — triggers
// exactly the `hand_rolled_codec_alphabet` block and nothing else (no
// compile error, no empty result, no preview-gap block).

import { describe, expect, test } from "bun:test";
import { MISSING_EVIDENCE_NEXT_ACTIONS, runRecordedEval } from "../../recorded-eval.ts";

// The full sequential standard base64 alphabet, the literal a hand-rolled
// encoder embeds — matches HAND_ROLLED_B64_ALPHABET_RE.
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

describe("runRecordedEval — hand-rolled-codec block next-action wire shape", () => {
  // The wire contract is the constant value itself — pin it so a rename of
  // the literal is a compile-and-test failure, not a silent client break.
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
            // Self-contained: no sibling $scope reference, so the only
            // gate that can fire is the static hand-rolled-codec detector.
            expression: `const A = "${B64_ALPHABET}"; let out = ""; for (let i = 0; i < input.input.length; i++) out += A[i % 64]; return out;`,
          },
        ],
      },
      { latest_preview: null },
    );

    // The transform gate must have flagged exactly the codec block.
    expect(report.gates.transform.ok).toBe(false);
    expect(report.gates.transform.blocks).toHaveLength(1);
    expect(report.gates.transform.blocks[0]?.reason).toBe("hand_rolled_codec_alphabet");
    expect(report.ok).toBe(false);

    // missing_evidence: keyed on the transform step id, next_action is the
    // codec-rewrite constant (NOT the preview-gap dry_run_workflow value).
    const codecEntry = report.missing_evidence.find((m) => m.step_id === "encode");
    expect(codecEntry).toBeDefined();
    expect(codecEntry?.next_action).toBe(MISSING_EVIDENCE_NEXT_ACTIONS.CODEC_REWRITE);
    expect(codecEntry?.next_action).not.toBe(MISSING_EVIDENCE_NEXT_ACTIONS.PREVIEW_GAP);

    // next_actions: the codec fix is an in-place source rewrite, so the
    // top-level steer is update_param / edit_workflow_patch — and it does
    // NOT push dry_run_workflow for a codec-only failure.
    expect(report.next_actions).toContain("update_param");
    expect(report.next_actions).toContain("edit_workflow_patch");
    expect(report.next_actions).not.toContain("dry_run_workflow");
  });
});

// #5: the next_action union is Zod-backed, so an out-of-contract value is
// rejected at the boundary instead of silently riding the wire.
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
