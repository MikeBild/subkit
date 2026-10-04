import { describe, expect, test } from "bun:test";
import { applyPatchToWorkflowDag } from "../../self-healing/patch-apply.ts";
import { shouldAutoApply } from "../../self-healing/policy.ts";
import {
  type GateFixPatch,
  planReportDeliveryDeclaration,
  planUtf8EncoderFix,
} from "../gate-fix.ts";
import { GMAIL_SEND_TARGET } from "../report-delivery-boundary.ts";

const ENCODE = "const msg = 'Subject: a — b';\nreturn { raw: sk.base64UrlEncode(msg) };";

// biome-ignore lint/suspicious/noTemplateCurlyInString: an authored workflow placeholder
function dag(expression: string, raw = "${scope.compose.data.raw}", language?: string) {
  return {
    steps: [
      { kind: "transform", id: "compose", ...(language ? { language } : {}), expression },
      { kind: "request", id: "send", method: "POST", url: GMAIL_SEND_TARGET, body: { raw } },
    ],
  };
}

const RECIPIENT = {
  kind: "gmail_report",
  to: "ops@example.com",
  from: "ops@example.com",
  content_type: "text/html",
} as const;

describe("planUtf8EncoderFix", () => {
  test("swaps the one binary encoder in the transform the report reads whole", () => {
    expect(planUtf8EncoderFix(dag(ENCODE), "send")).toEqual({
      step_id: "compose",
      ops: [
        {
          op: "replace",
          path: "/expression",
          value: "const msg = 'Subject: a — b';\nreturn { raw: sk.base64UrlEncodeUtf8(msg) };",
        },
      ],
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an authored workflow placeholder
    expect(planUtf8EncoderFix(dag(ENCODE, "${scope.compose.raw}"), "send")?.step_id).toBe(
      "compose",
    );
  });

  test("an already-UTF-8 encoder is not doubled", () => {
    expect(
      planUtf8EncoderFix(dag("return { raw: sk.base64UrlEncodeUtf8(msg) };"), "send"),
    ).toBeNull();
  });

  test("anything less exact is left to the author", () => {
    expect(planUtf8EncoderFix(dag(`${ENCODE}\nsk.base64UrlEncode(x);`), "send")).toBeNull();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an authored workflow placeholder
    expect(planUtf8EncoderFix(dag(ENCODE, "x${scope.compose.data.raw}"), "send")).toBeNull();
    expect(planUtf8EncoderFix(dag("return { raw: xsk.base64UrlEncode(m) };"), "send")).toBeNull();
    expect(planUtf8EncoderFix(dag(ENCODE, undefined, "jsonata"), "send")).toBeNull();
    expect(planUtf8EncoderFix(dag(ENCODE), "compose")).toBeNull();
  });
});

describe("planReportDeliveryDeclaration", () => {
  test("adds an observed recipient, replaces a contradicted one, keeps an equal one", () => {
    expect(planReportDeliveryDeclaration(dag(ENCODE), "send", RECIPIENT)?.ops).toEqual([
      { op: "add", path: "/report_delivery", value: RECIPIENT },
    ]);
    const declared = dag(ENCODE);
    (declared.steps[1] as Record<string, unknown>).report_delivery = {
      ...RECIPIENT,
      to: "other@example.com",
    };
    expect(planReportDeliveryDeclaration(declared, "send", RECIPIENT)?.ops[0]?.op).toBe("replace");
    (declared.steps[1] as Record<string, unknown>).report_delivery = RECIPIENT;
    expect(planReportDeliveryDeclaration(declared, "send", RECIPIENT)).toBeNull();
    expect(planReportDeliveryDeclaration(dag(ENCODE), "send", { to: "x" })).toBeNull();
  });
});

describe("applyPatchToWorkflowDag for gate_fix", () => {
  const plan = planUtf8EncoderFix(dag(ENCODE), "send");
  const patch: GateFixPatch = {
    fixer: "use_utf8_encoder",
    step_id: "compose",
    subject_step_id: "send",
    ops: plan?.ops ?? [],
  };
  const proposal = {
    classification: "unsafe" as const,
    kind: "gate_fix" as const,
    description: "",
    patch,
    reasoning: "",
  };

  test("applies only for a gate_block candidate", () => {
    const applied = applyPatchToWorkflowDag(dag(ENCODE), "compose", proposal, "gate_block");
    expect(applied.ok).toBe(true);
    expect(applied.ok && applied.changed_paths).toEqual(["expression"]);
    expect(applyPatchToWorkflowDag(dag(ENCODE), "compose", proposal, "schema_diff")).toEqual({
      ok: false,
      reason: "gate_fix_without_gate_block",
    });
    expect(applyPatchToWorkflowDag(dag(ENCODE), "compose", proposal)).toEqual({
      ok: false,
      reason: "gate_fix_without_gate_block",
    });
  });

  test("refuses stored ops the fixer would not compute, and reports an applied fix", () => {
    const forged = {
      ...proposal,
      patch: { ...patch, ops: [{ op: "replace", path: "/expression", value: "return 1;" }] },
    };
    expect(applyPatchToWorkflowDag(dag(ENCODE), "compose", forged, "gate_block")).toEqual({
      ok: false,
      reason: "gate_fix_mismatch",
    });
    const fixed = dag("return { raw: sk.base64UrlEncodeUtf8(msg) };");
    expect(applyPatchToWorkflowDag(fixed, "compose", proposal, "gate_block")).toEqual({
      ok: false,
      reason: "no_change",
    });
  });

  test("a gate repair is never auto-applied", () => {
    for (const policy of ["safe-patches", "never-auto", "dry-run-gate"] as const)
      expect(
        shouldAutoApply({
          policy,
          classification: "safe",
          fixture_passed: true,
          has_fixture: true,
          drift_kind: "gate_block",
        }),
      ).toBe(false);
  });
});
