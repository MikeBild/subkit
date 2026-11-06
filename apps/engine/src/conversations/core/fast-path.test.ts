import { describe, expect, test } from "bun:test";
import {
  AFFIRM_RESUME_WINDOW_MS,
  decideRunEnvironment,
  decideTurn,
  FAST_PATH_DEFAULT_ENVIRONMENT,
  gateSurfaceFor,
  listToolFor,
  READ_PERMISSION_BY_LIST,
  replayRefusal,
  resumableApprovalId,
  runNextActions,
  runReply,
  stepLine,
} from "./fast-path.ts";

const EXEC_ID = "0d7c9e3e-4b6f-4c1a-9f0e-1a2b3c4d5e6f";
const HELD = "held_preview";

describe("decideTurn", () => {
  test("blank text takes no route", () => {
    expect(decideTurn("")).toEqual([]);
    expect(decideTurn("   ")).toEqual([]);
  });

  test("a single list intent is the only route", () => {
    expect(decideTurn("  list my workflows  ")).toEqual([{ kind: "list", list: "workflows" }]);
    expect(decideTurn("show knowledge sources")).toEqual([
      { kind: "list", list: "knowledge_sources" },
    ]);
  });

  test("a category list comes first and keeps the reply language", () => {
    expect(decideTurn("zeige mir die subkit workflows")).toEqual([
      { kind: "category", category: "subkit", language: "de" },
    ]);
    expect(decideTurn("show the radar workflows")).toEqual([
      { kind: "category", category: "radar", language: "en" },
    ]);
  });

  test("a category candidate keeps the following terminal route as fallback", () => {
    expect(decideTurn("show the connectors workflows")).toEqual([
      { kind: "category", category: "connectors", language: "en" },
      { kind: "catalogs", lists: ["workflows", "connectors"] },
    ]);
  });

  test("several catalogs become one catalogs route", () => {
    expect(decideTurn("list my connectors and workflows")).toEqual([
      { kind: "catalogs", lists: ["workflows", "connectors"] },
    ]);
  });

  test("an execution id becomes an inspect route", () => {
    expect(decideTurn(`inspect execution ${EXEC_ID}`)).toEqual([
      { kind: "inspect", execution_id: EXEC_ID },
    ]);
  });

  test("a run verb with a slug becomes a run route", () => {
    expect(decideTurn("run daily-report")).toEqual([{ kind: "run", slug_or_id: "daily-report" }]);
    expect(decideTurn("führe den workflow aus")).toEqual([]);
  });

  test("an affirmation becomes an affirm route", () => {
    expect(decideTurn("yes")).toEqual([{ kind: "affirm" }]);
    expect(decideTurn("ja!")).toEqual([{ kind: "affirm" }]);
  });

  test("other text takes no route", () => {
    expect(decideTurn("what can you do?")).toEqual([]);
  });
});

describe("catalog lookups", () => {
  test("list tools and read permissions", () => {
    expect(listToolFor("knowledge_sources")).toBe("list_knowledge_sources");
    expect(listToolFor("schedules")).toBe("list_schedules");
    expect(READ_PERMISSION_BY_LIST).toEqual({
      workflows: "workflow:read",
      connectors: "connector:read",
      executions: "execution:read",
      schedules: "schedule:read",
      knowledge_sources: "knowledge:read",
    });
  });

  test("only mcp keeps the mcp gate surface", () => {
    expect(gateSurfaceFor("mcp")).toBe("mcp");
    expect(gateSurfaceFor("web")).toBe("chat");
    expect(gateSurfaceFor(undefined)).toBe("chat");
  });
});

describe("decideRunEnvironment", () => {
  test("a workflow without trigger or bindings runs in the default dev environment", () => {
    expect(FAST_PATH_DEFAULT_ENVIRONMENT).toBe("dev");
    expect(decideRunEnvironment({ kind: "default", dev_bindings: [] })).toBe("dev");
    expect(decideRunEnvironment({ kind: "default", dev_bindings: ["dev", "dev"] })).toBe("dev");
  });

  test("a default workflow whose connectors do not bind in dev leaves the turn to the model", () => {
    expect(decideRunEnvironment({ kind: "default", dev_bindings: ["dev", "prod"] })).toBeNull();
    expect(decideRunEnvironment({ kind: "default", dev_bindings: [null] })).toBeNull();
    expect(decideRunEnvironment({ kind: "default", dev_bindings: ["prod", "dev"] })).toBeNull();
  });

  test("a trigger or binding environment is kept", () => {
    expect(decideRunEnvironment({ kind: "resolved", environment: "prod" })).toBe("prod");
    expect(decideRunEnvironment({ kind: "resolved", environment: "dev" })).toBe("dev");
  });

  test("an ambiguous environment leaves the turn to the model", () => {
    expect(decideRunEnvironment({ kind: "ambiguous" })).toBeNull();
  });
});

describe("resumableApprovalId", () => {
  const now = 1_700_000_000_000;
  const pending = (created_at: Date | null, approval_id: unknown = "ap-1") => ({
    output: { pending: true },
    confirmation_data: { approval_id },
    created_at,
  });

  test("a fresh pending call with an approval resumes", () => {
    expect(resumableApprovalId(pending(new Date(now - 1000)), now)).toBe("ap-1");
    expect(resumableApprovalId(pending(new Date(now - AFFIRM_RESUME_WINDOW_MS + 1)), now)).toBe(
      "ap-1",
    );
  });

  test("the window is five minutes and exclusive", () => {
    expect(AFFIRM_RESUME_WINDOW_MS).toBe(300_000);
    expect(resumableApprovalId(pending(new Date(now - AFFIRM_RESUME_WINDOW_MS)), now)).toBeNull();
    expect(resumableApprovalId(pending(null), now)).toBeNull();
    expect(resumableApprovalId(pending(null), AFFIRM_RESUME_WINDOW_MS - 1)).toBe("ap-1");
  });

  test("no call, no pending flag or no approval id does not resume", () => {
    expect(resumableApprovalId(undefined, now)).toBeNull();
    expect(
      resumableApprovalId(
        {
          output: { pending: "true" },
          confirmation_data: { approval_id: "ap-1" },
          created_at: null,
        },
        0,
      ),
    ).toBeNull();
    expect(
      resumableApprovalId({ output: null, confirmation_data: null, created_at: null }, 0),
    ).toBeNull();
    expect(resumableApprovalId(pending(new Date(now), 7), now)).toBeNull();
    expect(
      resumableApprovalId(
        { output: { pending: true }, confirmation_data: null, created_at: new Date(now) },
        now,
      ),
    ).toBeNull();
  });
});

describe("replayRefusal", () => {
  test("a missing environment asks for a fresh confirmation", () => {
    expect(replayRefusal(true, "wf")).toEqual({
      reason: "approval_environment_missing",
      reply:
        "The confirmation names no environment; nothing was run. Ask again to obtain a fresh confirmation.",
    });
  });

  test("a missing workflow names the slug", () => {
    expect(replayRefusal(false, "wf")).toEqual({
      reason: "workflow_not_found",
      reply: "The workflow wf is no longer available; nothing was run.",
    });
    expect(replayRefusal(false, null).reply).toBe(
      "The workflow (unknown) is no longer available; nothing was run.",
    );
  });
});

describe("run replies", () => {
  const step = { step_key: "fetch", kind: "request", status: "failed", duration_ms: 12 };

  test("step lines show the duration when known", () => {
    expect(stepLine(step)).toBe("- fetch (request) failed · 12ms");
    expect(stepLine({ ...step, duration_ms: null })).toBe("- fetch (request) failed");
    expect(stepLine({ ...step, duration_ms: 0 })).toBe("- fetch (request) failed · 0ms");
  });

  test("a succeeded run renders its output", () => {
    expect(
      runReply(
        "wf",
        "run wf",
        { status: "succeeded", output: "done", steps: [], warnings: [] },
        HELD,
      ),
    ).toEqual({ ok: true, held_preview: false, reply: "done" });
  });

  test("a succeeded run without output says so and lists sorted unique warnings", () => {
    expect(
      runReply(
        "wf",
        "run wf",
        {
          status: "succeeded",
          output: null,
          steps: [],
          warnings: [{ code: "b" }, { code: "a" }, { code: "b" }],
        },
        HELD,
      ),
    ).toEqual({ ok: true, held_preview: false, reply: "Ran wf: succeeded\n\n3 warning(s): a, b" });
    expect(
      runReply("wf", "run wf", { status: "succeeded", output: 1, steps: [] }, HELD).reply,
    ).toBe("1");
  });

  test("a held preview never counts as ok and answers in the user's language", () => {
    const run = { status: "succeeded", output: "x", steps: [], warnings: [{ code: HELD }] };
    expect(runReply("wf", "  führe wf aus", run, HELD)).toEqual({
      ok: false,
      held_preview: true,
      reply:
        "Vorschau für wf: Es wurde nichts geschrieben. Prüfe vor einem Live-Lauf die Ausführungsfreigabe des Workflows.",
    });
    expect(runReply("wf", "run wf", run, HELD).reply).toBe(
      "Preview of wf: Nothing was written. Review the workflow's execution authority before a live run.",
    );
    expect(runReply("wf", "Starte wf", run, HELD).reply.startsWith("Vorschau")).toBe(true);
    expect(runReply("wf", "javascript", run, HELD).reply.startsWith("Preview")).toBe(true);
    expect(runReply("wf", "run ja", run, HELD).reply.startsWith("Preview")).toBe(true);
  });

  test("a failed run lists its steps and warnings", () => {
    expect(
      runReply(
        "wf",
        "run wf",
        { status: "failed", output: null, steps: [step], warnings: [{ code: "w" }] },
        HELD,
      ),
    ).toEqual({
      ok: false,
      held_preview: false,
      reply: "Ran wf: failed\n- fetch (request) failed · 12ms\n1 warning(s): w",
    });
    expect(
      runReply("wf", "run wf", { status: "failed", output: null, steps: [], warnings: [] }, HELD)
        .reply,
    ).toBe("Ran wf: failed");
  });

  test("next actions depend on success", () => {
    expect(runNextActions("succeeded")).toEqual(["inspect_execution_step", "run_workflow"]);
    expect(runNextActions("failed")).toEqual(["diagnose_latest_execution", "inspect_workflow"]);
  });
});
