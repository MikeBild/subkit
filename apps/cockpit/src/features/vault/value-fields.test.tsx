import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { render } from "@/components/cockpit/patterns/test-utils";
import { I18nContext } from "@/lib/i18n-context";
import { createBody, emptyDraft, rotateBody, type VaultDraft } from "./model/vault";
import { ValueFields } from "./page";

const CHILD_FLAG = "SUBKIT_VAULT_VALUE_FIELDS_DOM_CHILD";
const PEM = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "c3ludGhldGljLWtleS1saW5lLW9uZQ==",
  "c3ludGhldGljLWtleS1saW5lLXR3bw==",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

test("the secret value is a masked monospace text area without autocomplete or spellcheck", () => {
  const draft = { kind: "secret" as const, token: "", username: "", password: "" };
  const html = render(
    <ValueFields idPrefix="vault-add" draft={draft} onChange={() => {}} error={null} />,
    "de",
  );
  const field = tag(html, "vault-add-token");
  expect(field).toStartWith("<textarea");
  expect(field).toContain('data-masked="true"');
  expect(field).toContain("[-webkit-text-security:disc]");
  expect(field).toContain("font-mono");
  expect(field).toContain('autoComplete="off"');
  expect(field).toContain('spellCheck="false"');
  expect(field).toContain("required");
  expect(html).toContain("Die Zeilenumbrüche bleiben erhalten.");
  const en = render(
    <ValueFields idPrefix="vault-add" draft={draft} onChange={() => {}} error={null} />,
    "en",
  );
  expect(en).toContain("Line breaks are kept.");
});

test("the login password stays a single-line password input", () => {
  const draft = { kind: "login" as const, token: "", username: "", password: "" };
  const html = render(
    <ValueFields idPrefix="vault-add" draft={draft} onChange={() => {}} error={null} />,
    "de",
  );
  expect(tag(html, "vault-add-password")).toContain('type="password"');
});

function isolated(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (process.env[CHILD_FLAG] !== "1") {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "-t", name], {
        env: { ...process.env, [CHILD_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return;
    }
    await body();
  });
}

isolated("a pasted PEM keeps its line breaks in the submitted payload", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@ui/molecules/tooltip");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  let latest: VaultDraft = emptyDraft(true);
  function Harness() {
    const [draft, setDraft] = useState<VaultDraft>({ ...emptyDraft(true), name: "sftp-key" });
    latest = draft;
    return (
      <ValueFields
        idPrefix="vault-add"
        draft={draft}
        onChange={(change) => setDraft((prior) => ({ ...prior, ...change }))}
        error={null}
      />
    );
  }
  let root: Root | undefined;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(
        <I18nContext.Provider value={i18nValue("en")}>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </I18nContext.Provider>,
      );
    });
    const area = dom.window.document.querySelector<HTMLTextAreaElement>(
      '[data-testid="vault-add-token"]',
    );
    if (!area) throw new Error("token field missing");
    const setValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue?.call(area, PEM);
      area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    expect(createBody(latest)).toMatchObject({ kind: "secret", name: "sftp-key", token: PEM });
    expect(rotateBody(latest)).toEqual({ token: PEM });
    expect(PEM.split("\n").length).toBe(5);
  } finally {
    if (root) await act(async () => root?.unmount());
    dom.window.close();
  }
});
