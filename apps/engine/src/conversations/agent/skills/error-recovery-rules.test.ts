// Pin the error-recovery skill body's hard-rule blocks so a future
// rewrite can't quietly drop them. Every block here corresponds to a
// real failure mode the operator hit in production:
//
//   - "Contact support" / fake CLI commands (session abeefb33 follow-up)
//   - prose retry-vs-troubleshoot fork on auto_persist_failed
//   - typed Postgres-error react-by-code, not by prose
//   - mandatory ask_user_choice when a finite option set exists

import { describe, expect, test } from "bun:test";
import errorRecoveryAndRbac from "./content/error-recovery-and-rbac.md" with { type: "text" };

describe("error-recovery skill body — hard-rule pins", () => {
  test("self-hosted context block forbids 'Contact support'", () => {
    expect(errorRecoveryAndRbac).toContain("SELF-HOSTED CONTEXT");
    expect(errorRecoveryAndRbac).toMatch(/never suggest "Contact support"/i);
  });

  test("forbids hallucinated CLI commands (sk diagnose / sk health / sk repair)", () => {
    expect(errorRecoveryAndRbac).toMatch(/sk diagnose/);
    expect(errorRecoveryAndRbac).toMatch(/sk health/);
    expect(errorRecoveryAndRbac).toMatch(/sk repair/);
  });

  test("references real recovery levers (docker logs subkit-engine-1, restart the engine container)", () => {
    expect(errorRecoveryAndRbac).toMatch(/docker logs subkit-engine-1/);
    expect(errorRecoveryAndRbac).toMatch(/restart the engine container/);
  });

  test("translates Postgres error codes into structured next_best_actions", () => {
    expect(errorRecoveryAndRbac).toMatch(/slug_already_in_use/);
    expect(errorRecoveryAndRbac).toMatch(/in_use_by_dependent_rows/);
    expect(errorRecoveryAndRbac).toMatch(/missing_required_field/);
    expect(errorRecoveryAndRbac).toMatch(/auto_persist_failed/);
  });

  test("auto_persist_failed rule says retry ONCE with same input then ask_user_choice", () => {
    expect(errorRecoveryAndRbac).toMatch(/retry the failed tool ONCE/);
    expect(errorRecoveryAndRbac).toMatch(/ask_user_choice/);
  });

  test("forbids the prose retry-vs-troubleshoot anti-pattern by name", () => {
    expect(errorRecoveryAndRbac).toContain("abeefb33");
    expect(errorRecoveryAndRbac).toMatch(/transient database issue/i);
  });

  test("BANS the specific prose 'Would you like me to try saving again, or would you prefer to troubleshoot' shape", () => {
    expect(errorRecoveryAndRbac).toMatch(/Would you like me to try saving again/);
    expect(errorRecoveryAndRbac).toMatch(/BANNED|forbidden/i);
  });

  test("requires ask_user_choice with explicit options for finite-choice forks", () => {
    expect(errorRecoveryAndRbac).toMatch(/ask_user_choice[^\n]*explicit[^\n]*options/);
    // Concrete example labels appear in the rule body.
    expect(errorRecoveryAndRbac).toMatch(/Retry the save/);
    expect(errorRecoveryAndRbac).toMatch(/Inspect engine logs/);
    expect(errorRecoveryAndRbac).toMatch(/Abandon and start over/);
  });

  test("does NOT recommend 'sk status' as a real command (pinned out)", () => {
    // The text MENTIONS sk status only to flag that it doesn't exist;
    // tolerate the markdown backtick wrapping in the assertion.
    if (errorRecoveryAndRbac.includes("sk status")) {
      expect(errorRecoveryAndRbac).toMatch(/sk status[`\s]+does NOT exist/);
    }
  });
});
