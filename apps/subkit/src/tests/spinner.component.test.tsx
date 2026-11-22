import { describe, expect, test } from "bun:test";
import { Spinner } from "../repl/spinner.tsx";
import { renderInk } from "./helpers/ink.tsx";

describe("Spinner (component)", () => {
  test("inactive renders an invisible row placeholder (stable layout)", () => {
    const ui = renderInk(<Spinner active={false} />);
    try {
      expect(ui.text().trim()).toBe("");
    } finally {
      ui.unmount();
    }
  });

  test("active renders first braille glyph + pinned verb", async () => {
    const ui = renderInk(<Spinner active={true} verbs={["only-thinking"]} />);
    try {
      await ui.waitFor((t) => t.includes("only-thinking"));
      const text = ui.text();
      expect(text).toContain("⠋");
      expect(text).toContain("only-thinking…");
    } finally {
      ui.unmount();
    }
  });

  test("active + turnTokens surfaces the token count", async () => {
    const ui = renderInk(<Spinner active={true} verbs={["thinking"]} turnTokens={1234} />);
    try {
      await ui.waitFor((t) => t.includes("1234t"));
      expect(ui.text()).toMatch(/·\s*1234t/);
    } finally {
      ui.unmount();
    }
  });

  test("active + turnTokens=0 suppresses the token suffix", async () => {
    const ui = renderInk(<Spinner active={true} verbs={["thinking"]} turnTokens={0} />);
    try {
      await ui.waitFor((t) => t.includes("thinking"));
      expect(ui.text()).not.toMatch(/\d+t/);
    } finally {
      ui.unmount();
    }
  });
});
