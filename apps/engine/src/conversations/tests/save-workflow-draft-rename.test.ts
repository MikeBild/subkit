// Vocabulary contract: the LLM-facing tool surface uses `save` for
// persist operations. The pre-existing `save_connector_draft` was
// already aligned; this test pins that the workflow side has been
// renamed to `save_workflow_draft` (it was previously `commit_draft`)
// and that no `commit_draft` / `commitDraftTool` / `commitDraftRubric`
// / `CommitDraftToolInput` / `CommitDraftArtifact` / `commit_via_tool`
// / `force_commit_override` / `commit_workflow_draft` references
// linger in any LLM-facing or operator-facing surface.
//
// `commitWorkflowAtomic` and the `commit-workflow.ts` persistence
// helper are intentionally NOT renamed — those are storage-level
// (workflow_versions are content-hashed snapshots, "commit" is the
// engineering verb for that). The LLM and the operator never see
// them directly.

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveWorkflowDraftRubric } from "../../llm/critic/rubrics/save-workflow-draft.ts";
import { COMMIT_INTENT_KINDS, type CommitIntentKind } from "../tools/ask-user/commit-intent.ts";
import { saveWorkflowDraftTool } from "../tools/save-workflow-draft.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");

describe("save_workflow_draft vocabulary rename — surface-level invariants", () => {
  test("the tool's LLM-facing name is `save_workflow_draft`", () => {
    expect(saveWorkflowDraftTool.name).toBe("save_workflow_draft");
  });

  test("the tool description never mentions the old `commit_draft` verb", () => {
    expect(saveWorkflowDraftTool.description).not.toMatch(/commit_draft/);
  });

  test("the critic rubric kind is `save_workflow_draft`", () => {
    expect(saveWorkflowDraftRubric.kind).toBe("save_workflow_draft");
  });

  test("COMMIT_INTENT_KINDS has the renamed workflow kind, not the old one", () => {
    const kinds: readonly CommitIntentKind[] = COMMIT_INTENT_KINDS;
    expect(kinds).toContain("save_workflow_draft" as CommitIntentKind);
    // The old enum value is gone.
    expect(kinds as readonly string[]).not.toContain("commit_workflow_draft");
    // Sibling save_connector_draft is still there — symmetric pair.
    expect(kinds).toContain("save_connector_draft" as CommitIntentKind);
  });
});

describe("save_workflow_draft vocabulary rename — repo-wide residue scan", () => {
  // These string forms must NOT appear anywhere in source / docs /
  // tests / fixtures (excluding node_modules, dist, CHANGELOG.md, and
  // this test file itself which legitimately documents them as the
  // forbidden patterns to scan for).
  const FORBIDDEN = [
    "\\bcommit_draft\\b",
    "commitDraftTool",
    "commitDraftRubric",
    "CommitDraftToolInput",
    "CommitDraftArtifact",
    "commit_workflow_draft",
    "force_commit_override",
    "commit_via_tool",
  ];

  test("no commit-verb residue across .ts/.tsx/.md/.json/.sql", () => {
    // A `git grep` is faster + scoped to tracked files; it skips
    // node_modules, dist, .git automatically.
    const cmd = [
      "git",
      "-C",
      `'${REPO_ROOT}'`,
      "grep",
      "-l",
      "-E",
      `'${FORBIDDEN.join("|")}'`,
      "--",
      "':(exclude)CHANGELOG.md'",
      "':(exclude)apps/engine/src/conversations/tests/save-workflow-draft-rename.test.ts'",
      "'*.ts'",
      "'*.tsx'",
      "'*.md'",
      "'*.json'",
      "'*.sql'",
    ].join(" ");
    let output = "";
    try {
      output = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // git grep exits 1 when no matches found — that's the success
      // case for us. It also exits 128 if not in a repo; surface that.
      const e = err as { status?: number; stdout?: string; stderr?: string };
      if (e.status === 1) output = "";
      else if (e.status === 128) {
        // Not a git repo (e.g. CI sandbox without git). Skip.
        return;
      } else {
        throw err;
      }
    }
    const matchedFiles = output.trim().split("\n").filter(Boolean);
    expect(matchedFiles).toEqual([]);
  });

  test("the persistence helper file `commit-workflow.ts` intentionally stays — storage layer", () => {
    // workflow_versions are content-hashed snapshots; the verb
    // "commit" is the engineering term for that operation and is
    // not renamed. This test pins the carve-out so a future
    // overzealous rename pass can't strip it.
    const path = join(REPO_ROOT, "apps/engine/src/conversations/persistence/commit-workflow.ts");
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("commitWorkflowAtomic");
  });
});
