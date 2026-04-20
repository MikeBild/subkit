// Ink-component coverage for MentionPicker. The pure helpers
// (extractMention, applyMention, scanFiles) are covered in
// mention-picker.test.ts; this file exercises the interactive rendering
// and keyboard handling.

import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MentionPicker } from "../repl/mention-picker.tsx";
import { renderInk } from "./helpers/ink.tsx";

function seededCwd(files: string[]): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "sk-mp-comp-"));
  for (const f of files) writeFileSync(join(cwd, f), "");
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

describe("MentionPicker (component)", () => {
  test("renders file candidates for a query", async () => {
    const { cwd, cleanup } = seededCwd(["README.md", "CHANGELOG.md"]);
    const ui = renderInk(<MentionPicker query="RE" cwd={cwd} onPick={mock()} onDismiss={mock()} />);
    try {
      await ui.waitFor((t) => t.includes("README.md"));
      expect(ui.text()).toContain("@README.md");
    } finally {
      ui.unmount();
      cleanup();
    }
  });

  test("renders the 'no matches' branch when nothing matches", async () => {
    const { cwd, cleanup } = seededCwd([]);
    const ui = renderInk(
      <MentionPicker query="zzz" cwd={cwd} onPick={mock()} onDismiss={mock()} />,
    );
    try {
      await ui.waitFor((t) => t.includes("no matches"));
      expect(ui.text()).toContain("@zzz");
      expect(ui.text()).toContain("Esc to dismiss");
    } finally {
      ui.unmount();
      cleanup();
    }
  });

  test("Enter picks the focused candidate", async () => {
    const { cwd, cleanup } = seededCwd(["alpha.ts", "beta.ts"]);
    const onPick = mock();
    const ui = renderInk(<MentionPicker query="" cwd={cwd} onPick={onPick} onDismiss={mock()} />);
    try {
      await ui.waitFor((t) => t.includes("alpha.ts"));
      await ui.press("enter");
      expect(onPick).toHaveBeenCalledTimes(1);
      const picked = onPick.mock.calls[0]?.[0] as { value: string } | undefined;
      expect(picked?.value).toMatch(/\.ts$/);
    } finally {
      ui.unmount();
      cleanup();
    }
  });

  test("↓ moves focus to the next candidate before Enter", async () => {
    const { cwd, cleanup } = seededCwd(["a.ts", "b.ts", "c.ts"]);
    const onPick = mock();
    const ui = renderInk(<MentionPicker query="" cwd={cwd} onPick={onPick} onDismiss={mock()} />);
    try {
      await ui.waitFor((t) => t.includes("a.ts") && t.includes("b.ts"));
      await ui.press("down");
      await ui.press("enter");
      const picked = onPick.mock.calls[0]?.[0] as { value: string } | undefined;
      expect(picked?.value).not.toBe("a.ts");
    } finally {
      ui.unmount();
      cleanup();
    }
  });

  test("Esc calls onDismiss", async () => {
    const { cwd, cleanup } = seededCwd(["x.ts"]);
    const onDismiss = mock();
    const ui = renderInk(
      <MentionPicker query="" cwd={cwd} onPick={mock()} onDismiss={onDismiss} />,
    );
    try {
      await ui.waitFor((t) => t.includes("x.ts"));
      await ui.press("esc");
      // allow-wall-clock: ink's esc disambiguation needs real ms.
      await new Promise((r) => setTimeout(r, 40));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      ui.unmount();
      cleanup();
    }
  });

  test("inputDisabled swallows keystrokes", async () => {
    const { cwd, cleanup } = seededCwd(["x.ts"]);
    const onPick = mock();
    const onDismiss = mock();
    const ui = renderInk(
      <MentionPicker
        query=""
        cwd={cwd}
        onPick={onPick}
        onDismiss={onDismiss}
        inputDisabled={true}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("x.ts"));
      await ui.press("enter");
      await ui.press("esc");
      await new Promise((r) => setTimeout(r, 40)); // allow-wall-clock: legacy; review before changing
      expect(onPick).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
      cleanup();
    }
  });

  test("engineCandidates merge with file matches", async () => {
    const { cwd, cleanup } = seededCwd(["doc.md"]);
    const ui = renderInk(
      <MentionPicker
        query=""
        cwd={cwd}
        engineCandidates={[{ value: "workflow:invoice", label: "invoice", kind: "workflow" }]}
        onPick={mock()}
        onDismiss={mock()}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("invoice"));
      expect(ui.text()).toContain("@doc.md");
      expect(ui.text()).toContain("@invoice");
    } finally {
      ui.unmount();
      cleanup();
    }
  });
});
