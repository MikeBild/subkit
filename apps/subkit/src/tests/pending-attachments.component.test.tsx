import { describe, expect, test } from "bun:test";
import type { StoredPaste } from "../repl/paste-store.ts";
import { PendingPasteRefs } from "../repl/pending-attachments.tsx";
import { renderInk } from "./helpers/ink.tsx";

describe("PendingPasteRefs (component)", () => {
  test("empty list renders nothing", () => {
    const ui = renderInk(<PendingPasteRefs items={[]} />);
    try {
      expect(ui.text().trim()).toBe("");
    } finally {
      ui.unmount();
    }
  });

  test("text paste shows line count + snippet", async () => {
    const item: StoredPaste = {
      id: 1,
      kind: "text",
      text: "hello\nworld\nthird line",
    };
    const ui = renderInk(<PendingPasteRefs items={[item]} />);
    try {
      await ui.waitFor((t) => t.includes("[1]"));
      const txt = ui.text();
      expect(txt).toContain("text");
      expect(txt).toContain("3 lines");
      expect(txt).toContain("paste refs · 1 pending");
    } finally {
      ui.unmount();
    }
  });

  test("image paste shows filename + media type + bytes", async () => {
    const item: StoredPaste = {
      id: 2,
      kind: "image",
      path: "/tmp/shot.png",
      mediaType: "image/png",
      bytes: 2048,
    };
    const ui = renderInk(<PendingPasteRefs items={[item]} />);
    try {
      await ui.waitFor((t) => t.includes("shot.png"));
      const txt = ui.text();
      expect(txt).toContain("image/png");
      expect(txt).toContain("2.0 KB");
    } finally {
      ui.unmount();
    }
  });

  test("pluralizes correctly for single-line text", async () => {
    const item: StoredPaste = {
      id: 3,
      kind: "text",
      text: "single",
    };
    const ui = renderInk(<PendingPasteRefs items={[item]} />);
    try {
      await ui.waitFor((t) => t.includes("1 line"));
      expect(ui.text()).toContain("1 line ·");
      expect(ui.text()).not.toContain("1 lines");
    } finally {
      ui.unmount();
    }
  });

  test("renders multiple items with distinct ids", async () => {
    const items: StoredPaste[] = [
      { id: 10, kind: "text", text: "one" },
      { id: 11, kind: "text", text: "two" },
    ];
    const ui = renderInk(<PendingPasteRefs items={items} />);
    try {
      await ui.waitFor((t) => t.includes("[10]") && t.includes("[11]"));
      expect(ui.text()).toContain("2 pending");
    } finally {
      ui.unmount();
    }
  });
});
