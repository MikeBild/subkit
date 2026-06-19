// Config tab — flat searchable list.
// Asserts the filter narrows as typed and two-step Esc clears + closes.

import { describe, expect, test } from "bun:test";
import type React from "react";
import type { EngineClient } from "../engine-client.ts";
import type { FormField } from "../settings-ui/lib/zod-to-form-fields.ts";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

const stubClient = {} as unknown as EngineClient;

function makeFields(): FormField[] {
  return [
    {
      path: "llm.model",
      kind: "text",
      value: "claude-opus-4-7",
      scope: "global",
      sensitive: false,
      requiresRestart: false,
      source: "global",
      description: "active model id",
    },
    {
      path: "llm.temperature",
      kind: "number",
      value: 0.2,
      scope: "global",
      sensitive: false,
      requiresRestart: false,
      source: "global",
      description: "sampling temperature",
    },
    {
      path: "knowledge.embed.model",
      kind: "text",
      value: "voyage-3",
      scope: "global",
      sensitive: false,
      requiresRestart: false,
      source: "global",
      description: "embedding model",
    },
  ];
}

function renderModalOnConfig(): ReturnType<typeof renderInk> {
  const node = (
    <SettingsModal
      fields={makeFields()}
      pendingRestartKeys={[]}
      overrideKeys={[]}
      client={stubClient}
      onExit={() => {}}
    />
  ) as React.ReactElement;
  return renderInk(node);
}

async function navigateToConfigTab(ui: ReturnType<typeof renderInk>): Promise<void> {
  // Status (idx 0) → Config (idx 1)
  await ui.press("right");
  await ui.waitFor((t) => t.includes("Type to filter"));
}

describe("ConfigTab — flat searchable settings list (M3)", () => {
  test("renders all leaves across sections by default", async () => {
    const ui = renderModalOnConfig();
    try {
      await navigateToConfigTab(ui);
      const txt = ui.text();
      // Row bodies render curated labels (see lib/config-labels.ts).
      // Section dividers humanize the section key.
      expect(txt).toContain("── AI / LLM");
      expect(txt).toContain("── Knowledge");
      // The fixture's `llm.temperature` isn't in LABEL_BY_PATH; the
      // formatLabel fallback ("Temperature") renders instead.
      expect(txt).toContain("Temperature");
    } finally {
      ui.unmount();
    }
  });

  test("focusing search with `/` and typing narrows by path", async () => {
    const ui = renderModalOnConfig();
    try {
      await navigateToConfigTab(ui);
      await ui.type("/");
      await ui.type("knowledge");
      // Selected-row footer surfaces the canonical path.
      await ui.waitFor((t) => t.includes("knowledge.embed.model"));
      const txt = ui.text();
      expect(txt).toContain("knowledge.embed.model");
      expect(txt).not.toContain("llm.model");
    } finally {
      ui.unmount();
    }
  });

  test("first Esc clears the filter (does not close the modal)", async () => {
    let exitCode: number | undefined;
    const ui = renderInk(
      <SettingsModal
        fields={makeFields()}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient}
        onExit={(c) => {
          exitCode = c;
        }}
      />,
    );
    try {
      await navigateToConfigTab(ui);
      await ui.type("/");
      await ui.type("knowledge");
      await ui.waitFor((t) => !t.includes("llm.model") && t.includes("knowledge.embed.model"));
      await ui.press("esc");
      // After clearing the filter, llm.model should be visible again.
      await ui.waitFor((t) => t.includes("llm.model"), { tries: 50, sleepMs: 10 });
      expect(exitCode).toBeUndefined();
    } finally {
      ui.unmount();
    }
  });

  test("Enter on a picker-eligible row opens a ValuePicker (G5 closure)", async () => {
    const themeFields: FormField[] = [
      {
        path: "ui.theme",
        kind: "text",
        value: "auto",
        scope: "tenant",
        sensitive: false,
        requiresRestart: false,
        source: "global",
        description: "REPL color theme",
      },
    ];
    const ui = renderInk(
      <SettingsModal
        fields={themeFields}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient}
        onExit={() => {}}
      />,
    );
    try {
      // Status (idx 0) → Config (idx 1)
      await ui.press("right");
      await ui.waitFor((t) => t.includes("ui.theme"));
      await ui.press("enter");
      // ThemePicker shows its four options + a preview hint.
      await ui.waitFor((t) => t.includes("Auto") && t.includes("Light") && t.includes("Dark"));
      expect(ui.text()).toContain("High contrast");
    } finally {
      ui.unmount();
    }
  });

  test("second Esc (with no active filter) closes the modal", async () => {
    let exitCode: number | undefined;
    const ui = renderInk(
      <SettingsModal
        fields={makeFields()}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={stubClient}
        onExit={(c) => {
          exitCode = c;
        }}
      />,
    );
    try {
      await navigateToConfigTab(ui);
      await ui.press("esc");
      await ui.waitFor(() => exitCode !== undefined, { tries: 50, sleepMs: 10 });
      expect(exitCode).toBe(0);
    } finally {
      ui.unmount();
    }
  });
});
