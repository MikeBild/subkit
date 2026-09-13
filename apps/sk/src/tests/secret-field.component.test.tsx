import { ThemeProvider } from "@chat-ui/index.ts";
import { describe, expect, test } from "bun:test";

import { SecretField } from "../domain/connectors/SecretField.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

describe("<SecretField>", () => {
  test("masks the value with bullet glyphs", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SecretField label="API key" value="hello-world" onChange={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("API key");
      expect(text).toContain("•".repeat("hello-world".length));
      // Plaintext must not be visible.
      expect(text).not.toContain("hello-world");
    } finally {
      ui.unmount();
    }
  });

  test("shows length counter alongside the masked value", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SecretField label="Token" value="abcd" onChange={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("(4)");
    } finally {
      ui.unmount();
    }
  });

  test("renders placeholder dim when value empty", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SecretField
          label="Secret"
          value=""
          placeholder="paste secret..."
          onChange={() => undefined}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("paste secret...");
    } finally {
      ui.unmount();
    }
  });

  test("Ctrl+E toggles reveal", async () => {
    let v = "abc123";
    const ui = renderInk(
      <ThemeProvider>
        <SecretField
          label="Secret"
          value={v}
          onChange={(next) => {
            v = next;
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      // Initial: masked
      expect(ui.text()).toContain("•".repeat(6));
      expect(ui.text()).not.toContain("abc123");
      // Send Ctrl+E to reveal — but ink's useInput still honors single keys.
      await ui.press("ctrlE");
      await flush();
      const revealed = ui.text();
      expect(revealed).toContain("abc123");
    } finally {
      ui.unmount();
    }
  });

  test("typing characters appends to the value via onChange", async () => {
    let v = "";
    const ui = renderInk(
      <ThemeProvider>
        <SecretField
          label="Secret"
          value={v}
          onChange={(next) => {
            v = next;
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.type("ab");
      await flush();
      // `value` is owned by the parent; we asserted onChange fired by
      // checking the captured local var.
      expect(v.length).toBeGreaterThan(0);
    } finally {
      ui.unmount();
    }
  });
});
