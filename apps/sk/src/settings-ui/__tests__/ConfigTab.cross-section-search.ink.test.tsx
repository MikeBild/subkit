import { describe, expect, test } from "bun:test";
import type { EngineClient, SettingPutResult } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import type { FormField } from "../lib/zod-to-form-fields.ts";
import { ConfigTab } from "../tabs/ConfigTab.tsx";

function leaf(path: string, value: string, description = ""): FormField {
  return {
    path,
    kind: "text",
    value,
    scope: "global",
    sensitive: false,
    requiresRestart: false,
    source: "default",
    description,
  };
}

function stubClient(): EngineClient {
  return {
    setSetting: async (): Promise<SettingPutResult> => ({
      value: "",
      requiresRestart: false,
    }),
  } as unknown as EngineClient;
}

const MULTI_SECTION_FIELDS: FormField[] = [
  leaf("log.level", "info", "log verbosity"),
  leaf("log.format", "ndjson", "log line format"),
  leaf("server.port", "3000", "http port"),
  leaf("llm.model", "claude-opus-4-7", "active model id"),
  leaf("llm.provider", "anthropic", "default llm provider"),
  leaf("ui.theme", "dark", "color theme"),
  leaf("ui.personality", "engineer", "voice/persona"),
];

describe("ConfigTab — flat search across sections", () => {
  test("filter 'theme' finds only ui.theme (not in any other section)", async () => {
    const ui = renderInk(<ConfigTab fields={MULTI_SECTION_FIELDS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.type("/");
      for (const ch of "theme") await ui.type(ch);
      await ui.waitFor((t) => t.includes("ui.theme"));
      const txt = ui.text();
      expect(txt).toContain("Theme");
      expect(txt).toContain("ui.theme");
      expect(txt).not.toContain("Log level");
      expect(txt).not.toContain("Primary AI model");
      expect(txt).not.toContain("HTTP port");
    } finally {
      ui.unmount();
    }
  });

  test("filter 'log' matches both log.level and log.format", async () => {
    const ui = renderInk(<ConfigTab fields={MULTI_SECTION_FIELDS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.type("/");
      for (const ch of "log") await ui.type(ch);
      await ui.waitFor((t) => t.includes("Log level"));
      const txt = ui.text();
      expect(txt).toContain("Log level");
      expect(txt).toContain("Log format");
      expect(txt).not.toContain("Primary AI model");
      expect(txt).not.toContain("Theme");
      expect(txt).not.toContain("HTTP port");
    } finally {
      ui.unmount();
    }
  });

  test("filter 'llm' matches every llm.* leaf via path", async () => {
    const ui = renderInk(<ConfigTab fields={MULTI_SECTION_FIELDS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.type("/");
      for (const ch of "llm") await ui.type(ch);
      await ui.waitFor((t) => t.includes("llm.model"));
      const txt = ui.text();
      expect(txt).toContain("Primary AI model");
      expect(txt).toContain("Primary AI provider");
      expect(txt).not.toContain("Log level");
      expect(txt).not.toContain("HTTP port");
      expect(txt).not.toContain("Theme");
    } finally {
      ui.unmount();
    }
  });

  test("filter on the human label matches", async () => {
    const ui = renderInk(<ConfigTab fields={MULTI_SECTION_FIELDS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.type("/");
      for (const ch of "primary") await ui.type(ch);
      await ui.waitFor((t) => t.includes("Primary AI model"));
      const txt = ui.text();
      expect(txt).toContain("Primary AI model");
      expect(txt).toContain("Primary AI provider");
      expect(txt).not.toContain("Log level");
    } finally {
      ui.unmount();
    }
  });

  test("filter on description text matches too", async () => {
    const ui = renderInk(<ConfigTab fields={MULTI_SECTION_FIELDS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.type("/");
      for (const ch of "verbosity") await ui.type(ch);
      await ui.waitFor((t) => t.includes("Log level"));
      expect(ui.text()).toContain("Log level");
    } finally {
      ui.unmount();
    }
  });

  test("Esc clears the filter and the full list returns", async () => {
    const ui = renderInk(<ConfigTab fields={MULTI_SECTION_FIELDS} client={stubClient()} />);
    try {
      await ui.waitFor((t) => t.includes("Type to filter"));
      await ui.type("/");
      for (const ch of "theme") await ui.type(ch);
      await ui.waitFor((t) => !t.includes("Log level"));
      await ui.press("esc");
      await ui.waitFor((t) => t.includes("Log level") && t.includes("Primary AI model"), {
        tries: 50,
        sleepMs: 10,
      });
      const txt = ui.text();
      expect(txt).toContain("Log level");
      expect(txt).toContain("Primary AI model");
      expect(txt).toContain("Theme");
    } finally {
      ui.unmount();
    }
  });
});
