import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { SlashSuggest } from "../repl/slash/SlashSuggest.tsx";
import type { PersonaProbe } from "../slash.ts";
import { flush, renderInk } from "./helpers/ink.tsx";

const ADMIN: PersonaProbe = { allows: () => true };
const ENDUSER: PersonaProbe = {
  allows: (p) => p === "conversation:write" || p === "conversation:read",
};

describe("<SlashSuggest>", () => {
  test("empty buffer renders the welcome hint with the visible count", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SlashSuggest buffer="" cursor={0} persona={ADMIN} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("press");
      expect(text).toContain("/");
      expect(text).toMatch(/\d+\s+commands?/);
    } finally {
      ui.unmount();
    }
  });

  test("renders nothing when the cursor isn't inside a slash token", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SlashSuggest buffer="hello" cursor={3} persona={ADMIN} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).not.toContain("type to filter");
      expect(text).not.toContain("›");
    } finally {
      ui.unmount();
    }
  });

  test("typing `/he` ranks /help among the suggestions", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SlashSuggest buffer="/he" cursor={3} persona={ADMIN} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("/help");
      expect(text).toContain("Show this cheat sheet");
    } finally {
      ui.unmount();
    }
  });

  test("persona filter hides admin-only commands from an enduser", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SlashSuggest buffer="/au" cursor={3} persona={ENDUSER} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).not.toContain("/audit");
    } finally {
      ui.unmount();
    }
  });

  test("admin sees /audit in /au suggestions", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SlashSuggest buffer="/au" cursor={3} persona={ADMIN} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("/audit");
    } finally {
      ui.unmount();
    }
  });

  test("does not match `/world` mid-word", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SlashSuggest buffer="hello/world" cursor={8} persona={ADMIN} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).not.toContain("›");
    } finally {
      ui.unmount();
    }
  });

  test("welcome hint can be suppressed", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SlashSuggest buffer="" cursor={0} persona={ADMIN} showWelcomeHint={false} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).not.toContain("press");
    } finally {
      ui.unmount();
    }
  });
});
