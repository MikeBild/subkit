// Ink-component coverage for WelcomeBanner. The tip-picker logic is
// covered in welcome-banner.test.ts; this file asserts on the render.

import { describe, expect, test } from "bun:test";
import { WelcomeBanner } from "../repl/welcome-banner.tsx";
import { renderInk } from "./helpers/ink.tsx";

describe("WelcomeBanner (component)", () => {
  test("renders persona + tenant in the header when tenant is set", async () => {
    const ui = renderInk(
      <WelcomeBanner persona="admin" tenant="acme" engineUrl="http://localhost:3000" />,
    );
    try {
      await ui.waitFor((t) => t.includes("admin@acme"));
      expect(ui.text()).toContain("admin@acme");
    } finally {
      ui.unmount();
    }
  });

  test("renders persona only when tenant is null", async () => {
    const ui = renderInk(
      <WelcomeBanner persona="admin" tenant={null} engineUrl="http://localhost:3000" />,
    );
    try {
      await ui.waitFor((t) => t.includes("admin"));
      expect(ui.text()).not.toContain("@");
    } finally {
      ui.unmount();
    }
  });

  test("version row includes a v prefix", async () => {
    const ui = renderInk(
      <WelcomeBanner persona="admin" tenant="acme" engineUrl="http://localhost:3000" />,
    );
    try {
      await ui.waitFor((t) => /v\d/.test(t));
      expect(ui.text()).toMatch(/· v\d/);
    } finally {
      ui.unmount();
    }
  });

  test("tip prop surfaces an emoji + the tip body", async () => {
    const ui = renderInk(
      <WelcomeBanner
        persona="admin"
        tenant="acme"
        engineUrl="http://localhost:3000"
        tip="Use /resume to reopen a session"
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Use /resume"));
      expect(ui.text()).toContain("Use /resume to reopen a session");
    } finally {
      ui.unmount();
    }
  });

  test("hint row lists the core slash commands", async () => {
    const ui = renderInk(
      <WelcomeBanner persona="admin" tenant="acme" engineUrl="http://localhost:3000" />,
    );
    try {
      await ui.waitFor((t) => t.includes("/help"));
      const txt = ui.text();
      expect(txt).toContain("/help");
      expect(txt).toContain("/resume");
      expect(txt).toContain("/view inspect");
      expect(txt).toContain("Ctrl-O");
    } finally {
      ui.unmount();
    }
  });
});
