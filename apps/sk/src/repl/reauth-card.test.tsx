// Fix 1 step 9 (plan review-last-login-thu-velvet-fiddle): the
// `request_connector_reauth` tool result gets a dedicated card —
// oauth2 authorization-code → "open in browser:" OSC 8 hyperlink line
// + auto-open via the validated browser helper; client_credentials →
// a short confirmation; errors / portal_setup → generic fallback.
// Non-TTY test env, so OSC 8 is forced on (G11 discipline).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetHyperlinkSupportCacheForTests } from "@chat-ui/index.ts";
import type { ToolCallState } from "@cli-core/index.ts";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { flush, waitFor } from "../../../engine/src/test-helpers/determinism/wait.ts";
import {
  extractReauthOutcome,
  ReauthCard,
  renderAuthoringCard,
  resetReauthAutoOpenForTests,
} from "./authoring-cards.tsx";

const OSC8_START = "\x1b]8;;";
const OSC8_END = "\x07";

const GRANT_URL =
  "https://engine.example.com/v1/connectors/0a1b2c3d-4e5f-6789-abcd-ef0123456789/oauth/start?grant=skog_AAAABBBBCCCCDDDDEEEEFFFF0000111122223333";

function reauthCall(data: Record<string, unknown>, id = "tc-reauth"): ToolCallState {
  return {
    id,
    name: "request_connector_reauth",
    args: { slug: "linkedin" },
    status: "done",
    result: { ok: true, data },
  };
}

function oauthLinkData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connector: "linkedin",
    method: "oauth2",
    reauth_url: GRANT_URL,
    // Fixed far-future instant: deterministic, and unambiguously ahead of
    // the component's real-clock expiry check.
    expires_at: "2999-01-01T00:00:00.000Z",
    single_use: true,
    instructions: "Present this URL verbatim on its own line as a bare URL.",
    needs_reauth: true,
    auth_failed_at: null,
    ...overrides,
  };
}

function strip(frame: string | undefined): string {
  return (frame ?? "").replace(/\[[0-9;]*m/g, "");
}

const tick = (): Promise<void> => flush();

/** The async chain behind a frame assertion (promise settle → React
 *  state update → ink re-render) needs more than one microtask on slow
 *  CI runners — poll deterministically instead of single-flushing. */
const waitForFrame = (ui: { lastFrame: () => string | undefined }, text: string): Promise<true> =>
  waitFor(() => strip(ui.lastFrame()).includes(text) || undefined, {
    label: `frame contains ${JSON.stringify(text)}`,
  }) as Promise<true>;

beforeEach(() => {
  process.env.SK_FORCE_HYPERLINKS = "1";
  resetHyperlinkSupportCacheForTests();
  resetReauthAutoOpenForTests();
});
afterEach(() => {
  delete process.env.SK_FORCE_HYPERLINKS;
  resetHyperlinkSupportCacheForTests();
  resetReauthAutoOpenForTests();
});

describe("ReauthCard — oauth2 authorization-code link", () => {
  test("renders the hyperlink line + expiry note and auto-opens the browser once", async () => {
    const call = reauthCall(oauthLinkData());
    const outcome = extractReauthOutcome(call);
    expect(outcome).not.toBeNull();
    if (!outcome) return;
    const openBrowser = mock(async (_url: string) => undefined);
    const ui = render(<ReauthCard call={call} outcome={outcome} openBrowser={openBrowser} />);
    await tick();
    const raw = ui.lastFrame() ?? "";
    const frame = strip(raw);
    expect(frame).toContain("sign-in needed: linkedin");
    expect(frame).toContain("open in browser:");
    // The URL renders as an OSC 8 hyperlink targeting the grant URL.
    expect(raw).toContain(`${OSC8_START}${GRANT_URL}${OSC8_END}`);
    expect(frame).toContain("single-use link");
    expect(frame).toContain("expires");
    // Auto-open fired exactly once, with the grant URL, and the card
    // reports the launch.
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser.mock.calls[0]?.[0]).toBe(GRANT_URL);
    await waitForFrame(ui, "browser opened — finish the sign-in there");
    ui.unmount();
  });

  test("does NOT auto-open twice for the same call id (remount/replay)", async () => {
    const call = reauthCall(oauthLinkData());
    const outcome = extractReauthOutcome(call);
    if (!outcome) throw new Error("outcome expected");
    const openBrowser = mock(async (_url: string) => undefined);
    const first = render(<ReauthCard call={call} outcome={outcome} openBrowser={openBrowser} />);
    await tick();
    first.unmount();
    const second = render(<ReauthCard call={call} outcome={outcome} openBrowser={openBrowser} />);
    await tick();
    expect(openBrowser).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  test("an EXPIRED link renders (copyable) but never auto-opens", async () => {
    const call = reauthCall(oauthLinkData({ expires_at: "2000-01-01T00:00:00.000Z" }));
    const outcome = extractReauthOutcome(call);
    if (!outcome) throw new Error("outcome expected");
    const openBrowser = mock(async (_url: string) => undefined);
    const ui = render(<ReauthCard call={call} outcome={outcome} openBrowser={openBrowser} />);
    await tick();
    const frame = strip(ui.lastFrame());
    expect(frame).toContain("link expired");
    expect(openBrowser).toHaveBeenCalledTimes(0);
    ui.unmount();
  });

  test("browser launch failure renders the manual-fallback hint", async () => {
    const call = reauthCall(oauthLinkData());
    const outcome = extractReauthOutcome(call);
    if (!outcome) throw new Error("outcome expected");
    const openBrowser = mock(async (_url: string) => {
      throw new Error("no display");
    });
    const ui = render(<ReauthCard call={call} outcome={outcome} openBrowser={openBrowser} />);
    await waitForFrame(ui, "browser launch failed — open the URL above manually");
    ui.unmount();
  });
});

describe("ReauthCard — machine (client_credentials) path", () => {
  test("renders a confirmation line, no link, no browser launch", async () => {
    const call = reauthCall({
      connector: "xray",
      method: "oauth2",
      status: "reauthorized",
      needs_reauth: false,
    });
    const outcome = extractReauthOutcome(call);
    expect(outcome).toEqual({ kind: "reauthorized", connector: "xray" });
    if (!outcome) return;
    const openBrowser = mock(async (_url: string) => undefined);
    const ui = render(<ReauthCard call={call} outcome={outcome} openBrowser={openBrowser} />);
    await tick();
    const raw = ui.lastFrame() ?? "";
    const frame = strip(raw);
    expect(frame).toContain("connector xray reauthorized");
    expect(frame).toContain("credential refreshed machine-side");
    expect(raw).not.toContain(OSC8_START);
    expect(openBrowser).toHaveBeenCalledTimes(0);
    ui.unmount();
  });
});

describe("renderAuthoringCard dispatch for request_connector_reauth", () => {
  test("machine result dispatches to the reauth card in chat mode", () => {
    const call = reauthCall({ connector: "xray", method: "oauth2", status: "reauthorized" });
    const node = renderAuthoringCard(call, "chat");
    expect(node).not.toBeNull();
    const ui = render(node as ReactElement);
    expect(strip(ui.lastFrame())).toContain("connector xray reauthorized");
    ui.unmount();
  });

  test("error envelope falls back to the generic milestone card", () => {
    const call: ToolCallState = {
      id: "tc-reauth-err",
      name: "request_connector_reauth",
      args: { slug: "ghost" },
      status: "done",
      result: { ok: false, error_code: "connector_not_found", message: "no connector" },
    };
    const node = renderAuthoringCard(call, "chat");
    expect(node).not.toBeNull();
    const ui = render(node as ReactElement);
    const frame = strip(ui.lastFrame());
    expect(frame).toContain("Connector re-auth failed");
    expect(frame).not.toContain("open in browser:");
    ui.unmount();
  });

  test("non-oauth credential_re_issue path falls back to the generic card (ask_user_form follows)", () => {
    const call = reauthCall({
      connector: "basic-api",
      method: "portal_setup",
      mode: "credential_re_issue",
      auth_type: "bearer",
    });
    expect(extractReauthOutcome(call)).toBeNull();
    const node = renderAuthoringCard(call, "chat");
    expect(node).not.toBeNull();
    const ui = render(node as ReactElement);
    expect(strip(ui.lastFrame())).toContain("Connector re-auth ready");
    ui.unmount();
  });

  test("a non-launchable reauth_url (non-http scheme) never reaches the browser path", () => {
    const call = reauthCall(oauthLinkData({ reauth_url: "javascript:alert(1)" }));
    expect(extractReauthOutcome(call)).toBeNull();
    const node = renderAuthoringCard(call, "chat");
    const ui = render(node as ReactElement);
    expect(strip(ui.lastFrame())).not.toContain("open in browser:");
    ui.unmount();
  });

  test("unrelated tools are unaffected by the new case", () => {
    const call: ToolCallState = {
      id: "tc-other",
      name: "list_workflows",
      args: {},
      status: "done",
      result: { ok: true, data: { workflows: [] } },
    };
    expect(renderAuthoringCard(call, "chat")).toBeNull();
  });
});
