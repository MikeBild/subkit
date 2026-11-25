import { describe, expect, test } from "bun:test";
import { ConfirmDialog } from "@ui/organisms/confirm-dialog";
import { render } from "./test-utils";
import { confirmOpen, useConfirmTarget } from "./use-confirm-target";

describe("confirmOpen", () => {
  test("a closed dialog has no target", () => {
    expect(confirmOpen(null)).toBe(false);
    expect(confirmOpen<"delete" | "stop">(null, "delete")).toBe(false);
  });

  test("any target opens the dialog when no single one is asked for", () => {
    expect(confirmOpen({ id: "k1" })).toBe(true);
    expect(confirmOpen(0)).toBe(true);
  });

  test("with `only`, one state drives several dialogs", () => {
    expect(confirmOpen<"delete" | "stop">("delete", "delete")).toBe(true);
    expect(confirmOpen<"delete" | "stop">("delete", "stop")).toBe(false);
  });
});

function Probe() {
  const confirm = useConfirmTarget<string>();
  return (
    <ConfirmDialog
      {...confirm.dialog()}
      title="Delete key"
      consequence="The key stops working."
      onConfirm={() => confirm.close()}
      testId="probe-confirm"
    />
  );
}

test("the dialog starts closed", () => {
  const html = render(<Probe />);
  expect(html).not.toContain('role="alertdialog"');
  expect(html).not.toContain("The key stops working.");
});
