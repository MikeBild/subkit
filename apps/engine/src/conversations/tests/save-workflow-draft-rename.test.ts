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
    expect(kinds as readonly string[]).not.toContain("commit_workflow_draft");
    expect(kinds).toContain("save_connector_draft" as CommitIntentKind);
  });
});

describe("save_workflow_draft vocabulary rename — repo-wide residue scan", () => {
  const FORBIDDEN = [
    "\\bcommit_draft\\b",
    "commitDraftTool",
    "commitDraftRubric",
    "CommitDraftToolInput",
    "CommitDraftArtifact",
    "commit_workflow_draft",
    "force_commit_override",
    "commit_via_tool",
    "gradeCommitDraft",
    "hintForCommitDraft",
    "CommitDraftVerdictSchema",
    "\\bCommitDraftVerdict\\b",
    "CommitDraftApproval",
    "CommitDraftApprovalProps",
  ];

  test("no commit-verb residue across .ts/.tsx/.md/.json/.sql", () => {
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
      const e = err as { status?: number; stdout?: string; stderr?: string };
      if (e.status === 1) output = "";
      else if (e.status === 128) {
        return;
      } else {
        throw err;
      }
    }
    const matchedFiles = output.trim().split("\n").filter(Boolean);
    expect(matchedFiles).toEqual([]);
  });

  test("the persistence helper file `commit-workflow.ts` intentionally stays — storage layer", () => {
    const path = join(REPO_ROOT, "apps/engine/src/conversations/persistence/commit-workflow.ts");
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("commitWorkflowAtomic");
  });
});
