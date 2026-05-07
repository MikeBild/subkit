import { describe, expect, test } from "bun:test";
import { dispatchInstallWizardSlash } from "../repl/slash/handlers/install-wizards.ts";

describe("dispatchInstallWizardSlash", () => {
  test("returns the redirect banner for known install slashes", () => {
    expect(dispatchInstallWizardSlash("install-slack")).toMatch(/run 'sk install slack'/i);
    expect(dispatchInstallWizardSlash("install-github")).toMatch(/run 'sk install github'/i);
    expect(dispatchInstallWizardSlash("install-google-workspace")).toMatch(/google-workspace/i);
    expect(dispatchInstallWizardSlash("install-salesforce")).toMatch(/salesforce/i);
    expect(dispatchInstallWizardSlash("install-jira")).toMatch(/jira/i);
    expect(dispatchInstallWizardSlash("install-hubspot")).toMatch(/hubspot/i);
    expect(dispatchInstallWizardSlash("install-teams")).toMatch(/teams/i);
  });

  test("returns undefined for unknown names", () => {
    expect(dispatchInstallWizardSlash("install-unknown")).toBeUndefined();
    expect(dispatchInstallWizardSlash("connector")).toBeUndefined();
    expect(dispatchInstallWizardSlash("")).toBeUndefined();
  });

  test("never instructs the operator to invoke a non-sk binary", () => {
    // R9-S1 contract — every banner says `sk install <kind>`, never a
    // direct `slack-cli`/`gh`/etc.
    const names = [
      "install-slack",
      "install-teams",
      "install-github",
      "install-google-workspace",
      "install-salesforce",
      "install-jira",
      "install-hubspot",
    ];
    for (const n of names) {
      const banner = dispatchInstallWizardSlash(n);
      expect(banner).toBeDefined();
      expect(banner).toContain("sk install");
    }
  });
});
