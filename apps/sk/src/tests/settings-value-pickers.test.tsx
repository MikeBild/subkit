// Theme/Personality/Title/Statusline pickers.

import { describe, expect, test } from "bun:test";

import {
  PersonalityPicker,
  StatuslineConfigurator,
  ThemePicker,
  TitleConfigurator,
} from "../settings-ui/components/ValuePickers.tsx";
import { renderInk } from "./helpers/ink.tsx";

describe("ThemePicker (M11)", () => {
  test("renders the four options + side-by-side preview at width ≥120", async () => {
    const ui = renderInk(
      <ThemePicker initial="auto" termWidth={140} onCommit={() => {}} onCancel={() => {}} />,
    );
    try {
      await ui.waitFor((t) => t.includes("Auto"));
      const txt = ui.text();
      expect(txt).toContain("Auto");
      expect(txt).toContain("Light");
      expect(txt).toContain("Dark");
      expect(txt).toContain("High contrast");
      expect(txt).toContain("preview");
    } finally {
      ui.unmount();
    }
  });

  test("Enter commits the focused value", async () => {
    let committed = "";
    const ui = renderInk(
      <ThemePicker
        initial="auto"
        termWidth={100}
        onCommit={(v) => {
          committed = v;
        }}
        onCancel={() => {}}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Auto"));
      await ui.press("down");
      await ui.press("enter");
      expect(committed).toBe("light");
    } finally {
      ui.unmount();
    }
  });

  test("Esc cancels (calls onCancel)", async () => {
    let cancelled = 0;
    const ui = renderInk(
      <ThemePicker
        initial="auto"
        termWidth={100}
        onCommit={() => {}}
        onCancel={() => {
          cancelled++;
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Auto"));
      await ui.press("esc");
      await ui.waitFor(() => cancelled > 0, { tries: 50, sleepMs: 10 });
      expect(cancelled).toBe(1);
    } finally {
      ui.unmount();
    }
  });
});

describe("PersonalityPicker (M11)", () => {
  test("renders the three options", async () => {
    const ui = renderInk(
      <PersonalityPicker initial="balanced" onCommit={() => {}} onCancel={() => {}} />,
    );
    try {
      await ui.waitFor((t) => t.includes("Personality"));
      const txt = ui.text();
      expect(txt).toContain("Concise");
      expect(txt).toContain("Balanced");
      expect(txt).toContain("Verbose");
    } finally {
      ui.unmount();
    }
  });
});

describe("TitleConfigurator (M11)", () => {
  test("renders the three preset formats with preview snippets", async () => {
    const ui = renderInk(
      <TitleConfigurator initial="session-id" onCommit={() => {}} onCancel={() => {}} />,
    );
    try {
      await ui.waitFor((t) => t.includes("Title format"));
      const txt = ui.text();
      expect(txt).toContain("Session id");
      expect(txt).toContain("Tenant + session");
      expect(txt).toContain("Model + tenant + session");
    } finally {
      ui.unmount();
    }
  });
});

describe("StatuslineConfigurator (M11)", () => {
  test("renders the three layouts", async () => {
    const ui = renderInk(
      <StatuslineConfigurator initial="minimal" onCommit={() => {}} onCancel={() => {}} />,
    );
    try {
      await ui.waitFor((t) => t.includes("Status line"));
      const txt = ui.text();
      expect(txt).toContain("Minimal");
      expect(txt).toContain("Compact");
      expect(txt).toContain("Detailed");
    } finally {
      ui.unmount();
    }
  });
});
