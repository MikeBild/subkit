import { describe, expect, test } from "bun:test";
import { shouldLoadBrowserWorkflowCleanup } from "./cockpit-workflow-cleanup-scope.mjs";

describe("local browser workflow cleanup scope", () => {
  test("allows chat receipt recovery when no workflow receipts exist", () => {
    expect(
      shouldLoadBrowserWorkflowCleanup({
        readOnly: false,
        chatOnly: false,
        workspaceOnly: false,
        cleanupOnly: true,
        apiReceiptPresent: false,
        browserReceiptPresent: false,
      }),
    ).toBe(false);
  });

  test("keeps workflow cleanup strict when either ownership receipt exists", () => {
    const base = {
      readOnly: false,
      chatOnly: false,
      workspaceOnly: false,
      cleanupOnly: true,
    };
    expect(() =>
      shouldLoadBrowserWorkflowCleanup({
        ...base,
        apiReceiptPresent: true,
        browserReceiptPresent: false,
      }),
    ).toThrow("Incomplete");
    expect(() =>
      shouldLoadBrowserWorkflowCleanup({
        ...base,
        apiReceiptPresent: false,
        browserReceiptPresent: true,
      }),
    ).toThrow("Incomplete");
    expect(
      shouldLoadBrowserWorkflowCleanup({
        ...base,
        apiReceiptPresent: true,
        browserReceiptPresent: true,
      }),
    ).toBe(true);
  });
});
