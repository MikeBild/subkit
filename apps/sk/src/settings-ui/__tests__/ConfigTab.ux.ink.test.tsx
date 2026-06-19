// End-user friendliness of the Config tab:
//   - Selected row shows its description in a footer (not just the
//     dotted path).
//   - Section dividers ("── log", "── llm", …) render between groups
//     when no filter is active.
//   - The list windows to ~12 rows; the row counter renders when the
//     total exceeds that window.

import { describe, expect, test } from "bun:test";
import type { EngineClient, SettingPutResult } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import type { FormField } from "../lib/zod-to-form-fields.ts";
import { ConfigTab } from "../tabs/ConfigTab.tsx";

function leaf(path: string, value: string, description?: string): FormField {
  const f: FormField = {
    path,
    kind: "text",
    value,
    scope: "global",
    sensitive: false,
    requiresRestart: false,
    source: "default",
  };
  if (description) f.description = description;
  return f;
}

function stubClient(): EngineClient {
  return {
    setSetting: async (): Promise<SettingPutResult> => ({ value: "", requiresRestart: false }),
  } as unknown as EngineClient;
}

const FIELDS_WITH_DESCRIPTIONS: FormField[] = [
  leaf("log.level", "info", "Log verbosity (debug | info | warn | error)"),
  leaf("log.format", "ndjson", "Log output format"),
  leaf("server.port", "3000", "HTTP listener port"),
  leaf("llm.provider", "anthropic", "Active LLM provider"),
  leaf("llm.model", "", "Default model identifier"),
];

describe("ConfigTab — description footer + section dividers", () => {
  test("selected row's description appears in the footer", async () => {
    const ui = renderInk(<ConfigTab fields={FIELDS_WITH_DESCRIPTIONS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      // log.level is selected by default (listIdx=0). The body row
      // shows the human label "Log level"; the footer surfaces the
      // engine schema description.
      await ui.waitFor((t) => t.includes("Log verbosity"));
      const txt = ui.text();
      expect(txt).toContain("Log level");
      expect(txt).toContain("Log verbosity");
      // Move selection to llm.provider — description changes.
      await ui.press("down");
      await ui.press("down");
      await ui.press("down");
      await ui.waitFor((t) => t.includes("Active LLM provider"));
      expect(ui.text()).toContain("Active LLM provider");
    } finally {
      ui.unmount();
    }
  });

  test("section dividers render with humanized headers when no filter is active", async () => {
    const ui = renderInk(<ConfigTab fields={FIELDS_WITH_DESCRIPTIONS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Log level"));
      const txt = ui.text();
      // Curated SECTION_LABEL entries (see lib/config-labels.ts).
      expect(txt).toContain("── Logging");
      expect(txt).toContain("── HTTP server");
      expect(txt).toContain("── AI / LLM");
    } finally {
      ui.unmount();
    }
  });

  test("section dividers are hidden while a filter is active", async () => {
    const ui = renderInk(<ConfigTab fields={FIELDS_WITH_DESCRIPTIONS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Log level"));
      await ui.type("/");
      for (const ch of "llm") await ui.type(ch);
      // Filter narrows to the AI / LLM section; Log level disappears.
      await ui.waitFor((t) => t.includes("Primary AI provider") && !t.includes("Log level"));
      const txt = ui.text();
      // No section header in filtered mode.
      expect(txt).not.toContain("── Logging");
      expect(txt).not.toContain("── HTTP server");
    } finally {
      ui.unmount();
    }
  });

  test("fallback message renders when description is absent", async () => {
    const ui = renderInk(
      <ConfigTab fields={[leaf("legacy.no_description_leaf", "x")]} client={stubClient()} />,
    );
    try {
      await ui.waitFor((t) => t.includes("legacy.no_description_leaf"));
      expect(ui.text()).toContain("(no description in engine schema)");
    } finally {
      ui.unmount();
    }
  });

  test("row counter renders when list exceeds the window", async () => {
    // 14 leaves > WINDOW_ROWS (12) → counter should show "1–12 of 14".
    const many = Array.from({ length: 14 }, (_, i) =>
      leaf(`log.opt_${String(i).padStart(2, "0")}`, "x"),
    );
    const ui = renderInk(<ConfigTab fields={many} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.waitFor((t) => /showing 1–12 of 14/.test(t));
      expect(ui.text()).toMatch(/showing 1–12 of 14/);
    } finally {
      ui.unmount();
    }
  });

  test("row counter is hidden when total fits in the window", async () => {
    const few = Array.from({ length: 5 }, (_, i) => leaf(`log.opt_${i}`, "x"));
    const ui = renderInk(<ConfigTab fields={few} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      const txt = ui.text();
      expect(txt).not.toMatch(/showing \d+–\d+ of \d+/);
    } finally {
      ui.unmount();
    }
  });

  test("window slides as selection moves past its bottom edge", async () => {
    // 14 leaves > WINDOW_ROWS (12). The first 12 (log.opt_00..log.opt_11)
    // are visible initially; log.opt_13 (the last leaf) is not.
    const many = Array.from({ length: 14 }, (_, i) =>
      leaf(`log.opt_${String(i).padStart(2, "0")}`, "x"),
    );
    const ui = renderInk(<ConfigTab fields={many} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("log.opt_00"));
      // Sanity: the last row isn't on-screen yet.
      expect(ui.text()).not.toContain("log.opt_13");
      // Move the selection to the end of the list.
      for (let i = 0; i < 13; i++) await ui.press("down");
      // The window has slid forward — log.opt_13 is now visible.
      await ui.waitFor((t) => t.includes("log.opt_13"), { tries: 50, sleepMs: 10 });
      expect(ui.text()).toContain("log.opt_13");
    } finally {
      ui.unmount();
    }
  });
});
