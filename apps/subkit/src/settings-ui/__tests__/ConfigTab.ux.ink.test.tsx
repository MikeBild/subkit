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
      await ui.waitFor((t) => t.includes("Log verbosity"));
      const txt = ui.text();
      expect(txt).toContain("Log level");
      expect(txt).toContain("Log verbosity");
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
      await ui.waitFor((t) => t.includes("Primary AI provider") && !t.includes("Log level"));
      const txt = ui.text();
      expect(txt).not.toContain("── Logging");
      expect(txt).not.toContain("── HTTP server");
    } finally {
      ui.unmount();
    }
  });

  test("fallback message renders when description is absent", async () => {
    const ui = renderInk(
      <ConfigTab fields={[leaf("misc.no_description_leaf", "x")]} client={stubClient()} />,
    );
    try {
      await ui.waitFor((t) => t.includes("misc.no_description_leaf"));
      expect(ui.text()).toContain("(no description in engine schema)");
    } finally {
      ui.unmount();
    }
  });

  test("row counter renders when list exceeds the window", async () => {
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
    const many = Array.from({ length: 14 }, (_, i) =>
      leaf(`log.opt_${String(i).padStart(2, "0")}`, "x"),
    );
    const ui = renderInk(<ConfigTab fields={many} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("log.opt_00"));
      expect(ui.text()).not.toContain("log.opt_13");
      for (let i = 0; i < 13; i++) await ui.press("down");
      await ui.waitFor((t) => t.includes("log.opt_13"), { tries: 50, sleepMs: 10 });
      expect(ui.text()).toContain("log.opt_13");
    } finally {
      ui.unmount();
    }
  });
});
