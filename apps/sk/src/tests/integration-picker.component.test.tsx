import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import {
  type ConnectorTemplate,
  IntegrationPicker,
} from "../domain/connectors/IntegrationPicker.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

const fakeConnectors: ConnectorTemplate[] = [
  { id: "1", slug: "stripe", display_name: "Stripe", category: "http" },
  { id: "2", slug: "stripe-connect", display_name: "Stripe Connect", category: "http" },
  { id: "3", slug: "github", display_name: "GitHub", category: "http" },
  { id: "4", slug: "postgres", display_name: "PostgreSQL", category: "postgres" },
];

describe("<IntegrationPicker>", () => {
  test("renders the full list when query is empty", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <IntegrationPicker connectors={fakeConnectors} onPick={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("Stripe");
      expect(text).toContain("GitHub");
      expect(text).toContain("PostgreSQL");
    } finally {
      ui.unmount();
    }
  });

  test("typing narrows the list", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <IntegrationPicker connectors={fakeConnectors} onPick={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.type("github");
      await flush();
      const text = ui.text();
      expect(text).toContain("GitHub");
      expect(text).not.toContain("PostgreSQL");
    } finally {
      ui.unmount();
    }
  });

  test("Enter calls onPick with the highlighted item", async () => {
    let picked: ConnectorTemplate | null = null;
    const ui = renderInk(
      <ThemeProvider>
        <IntegrationPicker
          connectors={fakeConnectors}
          onPick={(c) => {
            picked = c;
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.press("enter");
      await flush();
      expect(picked).not.toBeNull();
      expect((picked as ConnectorTemplate | null)?.slug).toBe("stripe");
    } finally {
      ui.unmount();
    }
  });

  test("Esc cancels", async () => {
    let cancelled = false;
    const ui = renderInk(
      <ThemeProvider>
        <IntegrationPicker
          connectors={fakeConnectors}
          onPick={() => undefined}
          onCancel={() => {
            cancelled = true;
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.press("esc");
      await ui.waitFor(() => cancelled, { tries: 50, sleepMs: 10 });
      expect(cancelled).toBe(true);
    } finally {
      ui.unmount();
    }
  });

  test("empty search renders helpful copy", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <IntegrationPicker connectors={[]} onPick={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("no connectors match");
    } finally {
      ui.unmount();
    }
  });
});
