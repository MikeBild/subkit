// Ink-component coverage for InlineHistorySearch (Ctrl-R panel).
// The pure ranking logic is covered in inline-history-search.test.ts;
// here we exercise the keyboard contract through ink.

import { describe, expect, mock, test } from "bun:test";
import { InlineHistorySearch } from "../repl/inline-history-search.tsx";
import { renderInk } from "./helpers/ink.tsx";

const HISTORY = [
  "run workflow invoice",
  "create connector stripe",
  "list skills",
  "run workflow daily-summary",
] as const;

describe("InlineHistorySearch (component)", () => {
  test("initial render shows (reverse-i-search) prompt with the most recent entry", async () => {
    const ui = renderInk(
      <InlineHistorySearch entries={HISTORY} onCommit={mock()} onCancel={mock()} />,
    );
    try {
      await ui.waitFor((t) => t.includes("reverse-i-search"));
      // most-recent-first — `daily-summary` is the top candidate.
      expect(ui.text()).toContain("daily-summary");
    } finally {
      ui.unmount();
    }
  });

  test("typing narrows the matches", async () => {
    const ui = renderInk(
      <InlineHistorySearch entries={HISTORY} onCommit={mock()} onCancel={mock()} />,
    );
    try {
      await ui.type("connect");
      await ui.waitFor((t) => t.includes("stripe"));
      expect(ui.text()).toContain("create connector stripe");
    } finally {
      ui.unmount();
    }
  });

  test("Enter commits the highlighted entry", async () => {
    const onCommit = mock();
    const ui = renderInk(
      <InlineHistorySearch entries={HISTORY} onCommit={onCommit} onCancel={mock()} />,
    );
    try {
      await ui.type("skills");
      await ui.waitFor((t) => t.includes("list skills"));
      await ui.press("enter");
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0]?.[0]).toBe("list skills");
    } finally {
      ui.unmount();
    }
  });

  test("Tab also commits (muscle-memory alias)", async () => {
    const onCommit = mock();
    const ui = renderInk(
      <InlineHistorySearch entries={HISTORY} onCommit={onCommit} onCancel={mock()} />,
    );
    try {
      await ui.type("skills");
      await ui.waitFor((t) => t.includes("list skills"));
      await ui.press("tab");
      expect(onCommit).toHaveBeenCalledTimes(1);
    } finally {
      ui.unmount();
    }
  });

  test("Esc cancels", async () => {
    const onCancel = mock();
    const ui = renderInk(
      <InlineHistorySearch entries={HISTORY} onCommit={mock()} onCancel={onCancel} />,
    );
    try {
      await ui.type("x");
      await ui.press("esc");
      // allow-wall-clock: esc disambiguation needs real ms.
      await new Promise((r) => setTimeout(r, 40));
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      ui.unmount();
    }
  });

  test("backspace trims the query", async () => {
    const ui = renderInk(
      <InlineHistorySearch entries={HISTORY} onCommit={mock()} onCancel={mock()} />,
    );
    try {
      await ui.type("abc");
      await ui.waitFor((t) => t.includes("`abc`"));
      await ui.press("backspace");
      await ui.waitFor((t) => t.includes("`ab`"));
      expect(ui.text()).toContain("`ab`");
    } finally {
      ui.unmount();
    }
  });

  test("empty history — enter does not fire onCommit", async () => {
    const onCommit = mock();
    const ui = renderInk(
      <InlineHistorySearch entries={[]} onCommit={onCommit} onCancel={mock()} />,
    );
    try {
      await ui.press("enter");
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });

  test("inputDisabled swallows all keystrokes", async () => {
    const onCommit = mock();
    const onCancel = mock();
    const ui = renderInk(
      <InlineHistorySearch
        entries={HISTORY}
        onCommit={onCommit}
        onCancel={onCancel}
        inputDisabled={true}
      />,
    );
    try {
      await ui.type("skills");
      await ui.press("enter");
      await ui.press("esc");
      await new Promise((r) => setTimeout(r, 40));
      expect(onCommit).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });
});
