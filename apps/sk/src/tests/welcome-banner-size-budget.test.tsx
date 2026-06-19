// Size-budget regression test for the welcome
// banner. This was once framed as a "token budget" but the
// banner is rendered to the terminal, not injected into the LLM
// context. The concrete operator-facing concern is: the first paint
// shouldn't grow into a screenful of text. This test pins the line
// count and rendered-byte count for the worst-case configuration
// (tip + whatsNew + signedIn=true + targetKind set + connection
// metadata) so a future addition surfaces in CI.

import { describe, expect, test } from "bun:test";
import { WelcomeBanner } from "../repl/welcome-banner.tsx";
import { renderInk } from "./helpers/ink.tsx";

describe("WelcomeBanner — size budget (H8)", () => {
  test("worst-case render fits under 16 lines and 2000 bytes", async () => {
    const ui = renderInk(
      <WelcomeBanner
        persona="alice@long-tenant-slug.example.com"
        tenant="long-tenant-slug"
        engineUrl="http://engine.long.example.com:3000"
        profileName="default"
        sessionId="abcdef0123456789-1234567890abcdef"
        mode="auto"
        transcriptMode="chat"
        connectionState="online"
        targetKind="workflow"
        targetName="long-named-workflow-slug"
        environment="production"
        tip="Use /resume to reopen a prior session without replaying the full transcript."
        whatsNew="v4.3.0 (unreleased) — long-running execution notifications + /session QR + /resume rewind"
        signedIn={true}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("auto"));
      const text = ui.text();
      const lineCount = text.split("\n").length;
      const byteCount = Buffer.byteLength(text, "utf8");
      // First-paint UX budget: ≤ 16 lines is the ceiling that keeps
      // the transcript visible above the fold on a typical 24-row
      // terminal even with all optional rows populated (tip,
      // what's-new, target, version-skew). Bytes are a coarser
      // sanity check on rendered density.
      expect(lineCount).toBeLessThanOrEqual(16);
      expect(byteCount).toBeLessThanOrEqual(2000);
    } finally {
      ui.unmount();
    }
  });

  test("minimal render (no tip, no whats-new, signed out) fits under 6 lines", async () => {
    const ui = renderInk(
      <WelcomeBanner
        persona="anonymous"
        tenant={null}
        engineUrl="http://localhost:3000"
        signedIn={false}
        compact={true}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("not signed in"));
      const lineCount = ui.text().split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(6);
    } finally {
      ui.unmount();
    }
  });
});
