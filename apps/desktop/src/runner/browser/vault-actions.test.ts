import { describe, expect, test } from "bun:test";
import type { BrowserPayArgs } from "@shared/device/browser.ts";
import { totpCode } from "@shared/totp.ts";
import { FIELD_SCAN_SCRIPT, parseFieldScan } from "../../shared/local/browser-rules.ts";
import { command, live, ok, outputOf, setup } from "./actions.fixture.ts";
import type { AgentBrowserResult } from "./agent-browser.ts";
import { payFingerprint, type SecretTickets } from "./vault-actions.ts";
import {
  checkVisibleTotal,
  createScriptLedger,
  DOCUMENT_PROBE_SCRIPT,
  FRAME_PROBE_SCRIPT,
  minorUnits,
  refFacts,
  TOTAL_PROBE_SCRIPT,
} from "./vault-fill.ts";

const SHOP = "https://shop.example.com";
const TICKET = "11111111-1111-4111-8111-111111111111";
const SEED = "JBSWY3DPEHPK3PXP";
const PAN = "4111111111111111";
const STRIPE = "https://js.stripe.com";

const SIGN_IN_SNAPSHOT = [
  '- textbox "Email" [ref=e1]',
  '- textbox "Password" [ref=e2]',
  '- textbox "Code" [ref=e3]',
  '- button "Sign in" [ref=e4]',
].join("\n");

const PAY_SNAPSHOT = [
  '- textbox "Card number" [ref=e1]',
  '- textbox "MM/YY" [ref=e2]',
  '- textbox "CVC" [ref=e3]',
  '- button "Pay 49,99 €" [ref=e4]',
].join("\n");

interface FakePage {
  url: string;
  title: string;
  timeOrigin: number;
  frames: Record<string, { origin: string; cross_origin?: boolean; tag?: string }>;
  snapshot: string;
  after: string;
  totals: string[];
  click?: () => Promise<AgentBrowserResult>;
}

function fakePage(snapshot: string, after: string): FakePage {
  return {
    url: `${SHOP}/login`,
    title: "Shop",
    timeOrigin: 1000,
    frames: {
      e1: { origin: SHOP },
      e2: { origin: SHOP },
      e3: { origin: SHOP },
      e4: { origin: SHOP, tag: "BUTTON" },
    },
    snapshot,
    after,
    totals: [],
  };
}

function tickets(values: Record<string, string>) {
  const claims: string[] = [];
  const handed: Map<string, string>[] = [];
  const store: SecretTickets = {
    async claim(ticket) {
      claims.push(ticket);
      if (claims.length > 1) return null;
      const map = new Map(Object.entries(values));
      handed.push(map);
      return map;
    },
  };
  return { store, claims, handed };
}

function harness(page: FakePage, values: Record<string, string>) {
  const ticket = tickets(values);
  const scripts = createScriptLedger();
  let focused = "";
  let submitted = false;
  const fills: { selector: unknown; text: unknown }[] = [];
  const env = setup(page, {
    tickets: ticket.store,
    scripts,
    extra: {
      agent_browser_focus: (args) => {
        focused = String(args.selector).replace("@", "");
        return ok({});
      },
      agent_browser_fill: (args) => {
        fills.push({ selector: args.selector, text: args.text });
        return ok({});
      },
      agent_browser_click: () => {
        submitted = true;
        return page.click ? page.click() : ok({});
      },
      agent_browser_snapshot: () => ok({ snapshot: submitted ? page.after : page.snapshot }),
      agent_browser_eval: (args) => {
        const script = String(args.script);
        if (script === DOCUMENT_PROBE_SCRIPT)
          return ok({
            result: JSON.stringify({
              page: page.url,
              time_origin: page.timeOrigin,
              structure: [["INPUT", "text", "email", "", ""]],
            }),
          });
        if (script === FRAME_PROBE_SCRIPT) {
          const frame = page.frames[focused];
          return ok({
            result: JSON.stringify({
              origin: frame?.origin ?? null,
              cross_origin: frame?.cross_origin ?? false,
              tag: frame?.cross_origin ? null : (frame?.tag ?? "INPUT"),
              type: "text",
            }),
          });
        }
        if (script === TOTAL_PROBE_SCRIPT)
          return ok({ result: JSON.stringify({ texts: page.totals }) });
        if (script === FIELD_SCAN_SCRIPT)
          return ok({ result: JSON.stringify({ dpr: 1, fields: [] }) });
        return ok({ result: "null" });
      },
    },
  });
  return { ...env, ticket, scripts, fills };
}

function signIn(overrides: Record<string, unknown> = {}) {
  return command("browser.sign_in", {
    origin: SHOP,
    fields: { username: "e1", password: "e2", code: "e3", submit: "e4" },
    secret_ticket: TICKET,
    kind: "totp",
    ...overrides,
  });
}

const LOGIN = { username: "mike@example.com", password: "hunter2-Secret!", totp_seed: SEED };

async function snapshotFirst(adapter: ReturnType<typeof harness>["adapter"]) {
  outputOf(await adapter.execute(command("browser.snapshot", {}), live()));
}

describe("browser.sign_in", () => {
  test("fills username, password and a device TOTP code, presses submit and redacts the answer", async () => {
    const page = fakePage(
      SIGN_IN_SNAPSHOT,
      '- heading "Welcome mike@example.com" [ref=e9]\n- text "hunter2-Secret!"',
    );
    const h = harness(page, LOGIN);
    await snapshotFirst(h.adapter);
    // allow-wall-clock: the runner derives the TOTP code from the real clock
    const before = Date.now();
    const output = outputOf(await h.adapter.execute(signIn(), live()));
    expect(output).toMatchObject({ filled: true, submitted: true, outcome: "submitted" });
    expect(h.ticket.claims).toEqual([TICKET]);
    expect(h.fills.map((fill) => fill.selector)).toEqual(["@e1", "@e2", "@e3"]);
    expect(h.fills[0]?.text).toBe(LOGIN.username);
    expect(h.fills[1]?.text).toBe(LOGIN.password);
    // allow-wall-clock: accept the code of either side of a 30 s window edge
    const codes = [totpCode(SEED, before), totpCode(SEED, Date.now())];
    expect(codes).toContain(String(h.fills[2]?.text));
    const text = JSON.stringify(output);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("mike@example.com");
    expect(text).toContain("***redacted***");
    expect(h.ticket.handed[0]?.size).toBe(0);
    expect(h.steps.at(-1)).toMatchObject({ action: "browser.sign_in", outcome: "done" });
  });

  test("refuses when a target field sits in a frame of another origin", async () => {
    const page = fakePage(SIGN_IN_SNAPSHOT, "");
    page.frames.e2 = { origin: "https://evil.example.net", cross_origin: true };
    const h = harness(page, LOGIN);
    await snapshotFirst(h.adapter);
    const output = outputOf(await h.adapter.execute(signIn(), live()));
    expect(output).toMatchObject({
      filled: false,
      submitted: false,
      outcome: "refused",
      reason: "frame_origin_mismatch",
    });
    expect(h.ticket.claims).toEqual([]);
    expect(h.fills).toEqual([]);
    expect(h.calls.some((call) => call.tool === "agent_browser_click")).toBe(false);
    expect(h.steps.at(-1)).toMatchObject({ code: "frame_origin_mismatch" });
  });

  test("refuses when the page is on another origin than the command names", async () => {
    const page = fakePage(SIGN_IN_SNAPSHOT, "");
    page.url = "https://shop.example.com.evil.example/login";
    const h = harness(page, LOGIN);
    await snapshotFirst(h.adapter);
    const output = outputOf(await h.adapter.execute(signIn(), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "origin_mismatch" });
    expect(h.ticket.claims).toEqual([]);
  });

  test("refuses when the document changed since the snapshot", async () => {
    const page = fakePage(SIGN_IN_SNAPSHOT, "");
    const h = harness(page, LOGIN);
    await snapshotFirst(h.adapter);
    page.timeOrigin = 2000;
    const output = outputOf(await h.adapter.execute(signIn(), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "document_changed" });
    expect(h.ticket.claims).toEqual([]);
    expect(h.fills).toEqual([]);
  });

  test("refuses without a snapshot of the current page", async () => {
    const h = harness(fakePage(SIGN_IN_SNAPSHOT, ""), LOGIN);
    const output = outputOf(await h.adapter.execute(signIn(), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "no_snapshot" });
  });

  test("refuses after a script that SubKit did not write ran since the last load", async () => {
    const h = harness(fakePage(SIGN_IN_SNAPSHOT, ""), LOGIN);
    await snapshotFirst(h.adapter);
    h.scripts.mark("default");
    const output = outputOf(await h.adapter.execute(signIn(), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "script_ran" });
    expect(h.ticket.claims).toEqual([]);
    await h.adapter.execute(command("browser.open", { url: `${SHOP}/login` }), live());
    expect(h.scripts.ran("default")).toBe(false);
  });

  test("claims a ticket once; the same command again is refused without asking the server", async () => {
    const h = harness(fakePage(SIGN_IN_SNAPSHOT, "- text ok"), LOGIN);
    await snapshotFirst(h.adapter);
    outputOf(await h.adapter.execute(signIn(), live()));
    await snapshotFirst(h.adapter);
    const again = outputOf(await h.adapter.execute(signIn(), live()));
    expect(again).toMatchObject({ outcome: "refused", reason: "ticket_used", filled: false });
    expect(h.ticket.claims).toEqual([TICKET]);
  });

  test("an expired or used ticket fills nothing", async () => {
    const h = harness(fakePage(SIGN_IN_SNAPSHOT, ""), LOGIN);
    h.ticket.claims.push("earlier");
    await snapshotFirst(h.adapter);
    const output = outputOf(await h.adapter.execute(signIn(), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "ticket_unavailable" });
    expect(h.fills).toEqual([]);
  });

  test("an unanswered submit is uncertain and never pressed again", async () => {
    const page = fakePage(SIGN_IN_SNAPSHOT, "");
    page.click = async () => ({ ok: false, code: "browser_timeout", error: "slow" });
    const h = harness(page, LOGIN);
    await snapshotFirst(h.adapter);
    const result = await h.adapter.execute(signIn(), live());
    expect(outputOf(result)).toMatchObject({
      filled: true,
      submitted: true,
      outcome: "uncertain",
    });
    expect(h.calls.filter((call) => call.tool === "agent_browser_click")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  test("a stop while the submit is on its way still reports uncertain, not stopped", async () => {
    const page = fakePage(SIGN_IN_SNAPSHOT, "");
    const abort = new AbortController();
    page.click = async () => {
      abort.abort();
      return { ok: false, code: "stopped", error: "Stopped." };
    };
    const h = harness(page, LOGIN);
    await snapshotFirst(h.adapter);
    const result = await h.adapter.execute(signIn(), abort.signal);
    expect(outputOf(result)).toMatchObject({ submitted: true, outcome: "uncertain" });
  });
});

function payArgs(page: FakePage): BrowserPayArgs {
  const base: BrowserPayArgs = {
    origin: SHOP,
    page_fingerprint: "0".repeat(64),
    fields: { number: "e1", exp: "e2", cvv: "e3", submit: "e4" },
    field_frames: {
      number: STRIPE,
      exp: STRIPE,
      exp_month: STRIPE,
      exp_year: STRIPE,
      holder: STRIPE,
      cvv: STRIPE,
      submit: SHOP,
    },
    secret_ticket: TICKET,
    amount_minor: 4999,
    currency: "EUR",
  };
  return { ...base, page_fingerprint: payFingerprint(base, refFacts({ snapshot: page.snapshot })) };
}

function payPage(): FakePage {
  const page = fakePage(PAY_SNAPSHOT, '- text "Paid with 4111 1111 1111 1111, CVC 737"');
  page.url = `${SHOP}/checkout`;
  for (const ref of ["e1", "e2", "e3"]) page.frames[ref] = { origin: STRIPE, cross_origin: true };
  page.totals = ["Zwischensumme 45,00 €", "Gesamtsumme 49,99 €"];
  return page;
}

const CARD = { number: PAN, exp_month: "7", exp_year: "2029", holder: "Mike Bild", cvv: "737" };

describe("browser.pay", () => {
  test("fills card fields in their approved frames and redacts the PAN even with spaces", async () => {
    const page = payPage();
    const h = harness(page, CARD);
    await snapshotFirst(h.adapter);
    const output = outputOf(await h.adapter.execute(command("browser.pay", payArgs(page)), live()));
    expect(output).toMatchObject({ filled: true, submitted: true, outcome: "submitted" });
    expect(h.fills.map((fill) => fill.text)).toEqual([PAN, "07/29", "737"]);
    const text = JSON.stringify(output);
    expect(text).not.toContain("4111 1111");
    expect(text).not.toContain("737");
    expect(h.ticket.handed[0]?.size).toBe(0);
  });

  test("refuses when the page fingerprint differs from the approved one", async () => {
    const page = payPage();
    const h = harness(page, CARD);
    await snapshotFirst(h.adapter);
    const args = { ...payArgs(page), page_fingerprint: "a".repeat(64) };
    const output = outputOf(await h.adapter.execute(command("browser.pay", args), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "fingerprint_changed" });
    expect(h.ticket.claims).toEqual([]);
  });

  test("refuses when the visible total is not the approved amount", async () => {
    const page = payPage();
    page.totals = ["Gesamtsumme 59,99 €"];
    const h = harness(page, CARD);
    await snapshotFirst(h.adapter);
    const output = outputOf(await h.adapter.execute(command("browser.pay", payArgs(page)), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "amount_mismatch" });
  });

  test("refuses a card field whose frame is not the approved one", async () => {
    const page = payPage();
    page.frames.e1 = { origin: SHOP };
    const h = harness(page, CARD);
    await snapshotFirst(h.adapter);
    const output = outputOf(await h.adapter.execute(command("browser.pay", payArgs(page)), live()));
    expect(output).toMatchObject({ outcome: "refused", reason: "frame_origin_mismatch" });
    expect(h.fills).toEqual([]);
  });
});

describe("vault helpers", () => {
  test("visible totals parse German and English amounts", () => {
    expect(minorUnits("1.234,56", 2)).toBe(123456);
    expect(minorUnits("1,234.56", 2)).toBe(123456);
    expect(minorUnits("49", 2)).toBe(4900);
    expect(checkVisibleTotal({ result: '{"texts":["Total $1,234.50"]}' }, 123450, "USD")).toBe(
      "match",
    );
    expect(checkVisibleTotal({ result: '{"texts":[]}' }, 100, "EUR")).toBe("unknown");
  });

  test("screenshots mask fields filled from the vault without calling them a secure focus", () => {
    const scan = parseFieldScan({
      result: JSON.stringify({
        dpr: 2,
        fields: [
          {
            type: "email",
            autocomplete: "",
            vault: true,
            focused: true,
            x: 10,
            y: 10,
            width: 100,
            height: 20,
          },
          { type: "text", autocomplete: "", focused: false, x: 0, y: 50, width: 100, height: 20 },
        ],
      }),
    });
    expect(scan).toMatchObject({ ok: true, secure_focus: false });
    if (scan.ok) expect(scan.rects).toHaveLength(1);
  });

  test("browser.fill still refuses password fields", async () => {
    const h = harness(fakePage(SIGN_IN_SNAPSHOT, ""), LOGIN);
    const page = { url: `${SHOP}/login`, title: "", attrs: { type: "password" } };
    const plain = setup(page);
    const result = await plain.adapter.execute(
      command("browser.fill", { mode: "fill", ref: "e2", text: "x" }),
      live(),
    );
    expect(result).toMatchObject({ status: "refused", code: "credential_field" });
    expect(h.ticket.claims).toEqual([]);
  });
});
