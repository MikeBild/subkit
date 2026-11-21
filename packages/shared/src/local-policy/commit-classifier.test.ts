import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_CASES } from "./commit-classifier.cases.ts";
import {
  alwaysAskClass,
  alwaysAskClassForName,
  type BrowserActionTarget,
  COMMIT_PATH_SEGMENTS,
  COMMIT_TERMS_LIST,
  CONSENT_TERMS_LIST,
  CREDENTIAL_AUTOCOMPLETE,
  classifyBrowserAction,
  DELETION_TERMS_LIST,
  DESTRUCTIVE_TERMS_LIST,
  isCredentialField,
  PAYMENT_TERMS_LIST,
  PREPARE_KEYS,
  PREPARE_NAMES_LIST,
  PREPARE_ROLES,
  READ_ACTIONS,
  SEARCH_NAMES_LIST,
  SENDING_TERMS_LIST,
  TERMS_TERMS_LIST,
} from "./commit-classifier.ts";

const PAGE = "https://shop.example.com/";

function click(name: string, extra: Partial<BrowserActionTarget> = {}): BrowserActionTarget {
  return { action: "click", page_url: PAGE, role: "button", name, ...extra };
}

describe("the term lists", () => {
  test("every plain commit term makes a button a commit, and only at a word start", () => {
    for (const term of COMMIT_TERMS_LIST.filter((t) => !t.includes("("))) {
      expect([term, classifyBrowserAction(click(term))]).toEqual([term, "commit"]);
      expect([term, classifyBrowserAction(click(`Mehr ${term.toUpperCase()}`))]).toEqual([
        term,
        "commit",
      ]);
    }
    expect(classifyBrowserAction(click("Cancel my order"))).toBe("commit");
    expect(classifyBrowserAction(click("Cancel  subscription"))).toBe("commit");
    expect(classifyBrowserAction(click("xsend"))).toBe("commit");
    expect(classifyBrowserAction(click("Weiter xsend"))).toBe("prepare");
  });

  test("every prepare and search name makes a plain button a preparation", () => {
    for (const term of [...PREPARE_NAMES_LIST, ...SEARCH_NAMES_LIST]) {
      expect([term, classifyBrowserAction(click(` ${term} `))]).toEqual([term, "prepare"]);
    }
  });

  test("every consent term marks a cookie banner, unless the button is destructive", () => {
    for (const term of CONSENT_TERMS_LIST) {
      expect([term, classifyBrowserAction(click("Alle akzeptieren", { container: term }))]).toEqual(
        [term, "prepare"],
      );
      expect([
        term,
        classifyBrowserAction({ action: "check", page_url: PAGE, role: "switch", name: term }),
      ]).toEqual([term, "prepare"]);
    }
    for (const term of DESTRUCTIVE_TERMS_LIST) {
      expect([term, classifyBrowserAction(click(term, { container: "Cookies" }))]).toEqual([
        term,
        "commit",
      ]);
      expect([term, classifyBrowserAction(click(term, { role: "link", href: "/x" }))]).toEqual([
        term,
        "commit",
      ]);
    }
  });

  test("every contract term makes a checkbox a commit", () => {
    for (const term of TERMS_TERMS_LIST) {
      expect([
        term,
        classifyBrowserAction({ action: "check", page_url: PAGE, role: "checkbox", name: term }),
      ]).toEqual([term, "commit"]);
    }
  });

  test("every commit path segment makes a link a commit, at a boundary only", () => {
    for (const segment of COMMIT_PATH_SEGMENTS) {
      for (const href of [
        `/a/${segment}`,
        `/a/${segment.toUpperCase()}/b`,
        `${segment}?x=1`,
        `/a?${segment}=1`,
      ]) {
        expect([href, classifyBrowserAction(click("Weiter", { role: "link", href }))]).toEqual([
          href,
          "commit",
        ]);
      }
      expect(
        classifyBrowserAction(click("Weiter", { role: "link", href: `/a/x${segment}x` })),
      ).toBe("read");
    }
  });

  test("every always-ask term maps to its class", () => {
    for (const term of PAYMENT_TERMS_LIST)
      expect([term, alwaysAskClassForName(term)]).toEqual([term, "payment"]);
    for (const term of DELETION_TERMS_LIST)
      expect([term, alwaysAskClassForName(term)]).toEqual([term, "deletion"]);
    for (const term of SENDING_TERMS_LIST)
      expect([term, alwaysAskClassForName(term)]).toEqual([term, "sending"]);
  });

  test("every listed key and read action is recognized", () => {
    for (const role of PREPARE_ROLES) {
      expect(role.length).toBeGreaterThan(0);
      expect(classifyBrowserAction(click("Unbekannt", { role }))).toBe("prepare");
    }
    for (const key of PREPARE_KEYS) {
      expect(key.length).toBeGreaterThan(0);
      expect(
        classifyBrowserAction({ action: "key", page_url: PAGE, key: ` ${key.toUpperCase()} ` }),
      ).toBe("prepare");
    }
    for (const action of READ_ACTIONS)
      expect(classifyBrowserAction({ action, page_url: PAGE })).toBe("read");
    for (const token of CREDENTIAL_AUTOCOMPLETE)
      expect(isCredentialField({ autocomplete: token })).toBe(true);
  });
});

describe("classifier details", () => {
  test("links: blank, script, foreign schemes and odd hrefs", () => {
    const link = (href: string) => classifyBrowserAction(click("Weiter", { role: "link", href }));
    expect(link("  ")).toBe("commit");
    expect(link("JavaScript:void(0)")).toBe("commit");
    expect(link("/page?next=javascript:x")).toBe("read");
    expect(link("http://shop.example.com/a")).toBe("read");
    expect(link("HTTPS://shop.example.com/a")).toBe("read");
    expect(link("page2.html?t=a:b")).toBe("read");
    expect(link("ftp://files.example.com/a")).toBe("commit");
    expect(link("Mailto:a@b.example")).toBe("commit");
  });

  test("forms: methods are trimmed and case-insensitive", () => {
    const submit = (form_method: string) =>
      classifyBrowserAction({ action: "submit", page_url: PAGE, name: "", form_method });
    expect(submit(" GET ")).toBe("prepare");
    expect(submit("")).toBe("prepare");
    expect(submit(" Post ")).toBe("commit");
    expect(classifyBrowserAction({ action: "submit", page_url: PAGE, name: "" })).toBe("prepare");
    expect(
      classifyBrowserAction({ action: "submit", page_url: PAGE, name: "", form_action: "/LOGOUT" }),
    ).toBe("commit");
    expect(
      classifyBrowserAction(click("Calculate", { in_form: true, input_type: " BUTTON " })),
    ).toBe("commit");
    expect(classifyBrowserAction(click("Calculate", { in_form: false }))).toBe("commit");
    expect(classifyBrowserAction(click("Calculate", { in_form: true, role: "" }))).toBe("commit");
    expect(classifyBrowserAction(click("Calculate", { in_form: true, role: "tab" }))).toBe(
      "prepare",
    );
  });

  test("a search context lets an order-like name prepare", () => {
    expect(
      classifyBrowserAction(click("Find orders", { in_form: true, form_role: " Search " })),
    ).toBe("prepare");
    expect(
      classifyBrowserAction({
        action: "key",
        key: "Enter",
        page_url: PAGE,
        role: "searchbox",
        name: "Search orders",
        in_form: true,
      }),
    ).toBe("prepare");
    expect(
      classifyBrowserAction({
        action: "key",
        key: "Enter",
        page_url: PAGE,
        role: "textbox",
        name: "Search orders",
        in_form: true,
      }),
    ).toBe("commit");
  });

  test("filling and selecting never commit, even with a commit-like name", () => {
    expect(
      classifyBrowserAction({
        action: "fill",
        page_url: PAGE,
        role: "textbox",
        name: "Nachricht senden an",
      }),
    ).toBe("prepare");
    expect(
      classifyBrowserAction({
        action: "select",
        page_url: PAGE,
        role: "combobox",
        name: "Order by",
      }),
    ).toBe("prepare");
    expect(classifyBrowserAction({ action: "key", key: "xtab", page_url: PAGE })).toBe("commit");
    expect(classifyBrowserAction({ action: "key", key: "tabx", page_url: PAGE })).toBe("commit");
  });

  test("always-ask needs a commit, except for credential entry", () => {
    expect(
      alwaysAskClass(click("Auswahl senden", { container: "Cookie-Einstellungen" })),
    ).toBeNull();
    expect(
      alwaysAskClass(
        { action: "select", page_url: PAGE, role: "combobox", name: "Monat" },
        { autocomplete: "cc-exp-month" },
      ),
    ).toBe("credential");
    expect(
      alwaysAskClass({
        action: "fill",
        page_url: PAGE,
        role: "textbox",
        name: "PIN",
        input_type: "password",
      }),
    ).toBe("credential");
  });
});

describe("browser action cases", () => {
  test("cover both directions with at least 150 cases", () => {
    expect(BROWSER_ACTION_CASES.length).toBeGreaterThanOrEqual(150);
    expect(new Set(BROWSER_ACTION_CASES.map((c) => c.id)).size).toBe(BROWSER_ACTION_CASES.length);
    expect(BROWSER_ACTION_CASES.some((c) => c.direction === "needless_ask")).toBe(true);
    expect(BROWSER_ACTION_CASES.some((c) => c.direction === "over_permission")).toBe(true);
  });

  for (const c of BROWSER_ACTION_CASES) {
    test(`${c.id} → ${c.expected}, always ask: ${c.always_ask ?? "no"}`, () => {
      expect(classifyBrowserAction(c.target)).toBe(c.expected);
      expect(alwaysAskClass(c.target, c.field)).toBe(c.always_ask);
    });
  }
});

describe("always-ask classes by name", () => {
  test("payment wins over sending and deletion", () => {
    expect(alwaysAskClassForName("Bestellung absenden")).toBe("payment");
    expect(alwaysAskClassForName("Remove and pay")).toBe("payment");
    expect(alwaysAskClassForName("Delete and send")).toBe("deletion");
    expect(alwaysAskClassForName("Save")).toBeNull();
    expect(alwaysAskClassForName("")).toBeNull();
    expect(alwaysAskClassForName(null)).toBeNull();
    expect(alwaysAskClassForName(undefined)).toBeNull();
  });

  test("a read action never asks, even with a payment name", () => {
    expect(
      alwaysAskClass({ action: "extract", page_url: "https://a.example.com", name: "Pay" }),
    ).toBeNull();
  });

  test("a click is not treated as credential entry", () => {
    expect(
      alwaysAskClass(
        {
          action: "click",
          page_url: "https://a.example.com",
          name: "Show",
          input_type: "password",
        },
        {},
      ),
    ).toBeNull();
  });
});

describe("credential fields", () => {
  test("password type and credential autocomplete tokens are credential fields", () => {
    expect(isCredentialField({ input_type: "PASSWORD" })).toBe(true);
    expect(isCredentialField({ autocomplete: "current-password" })).toBe(true);
    expect(isCredentialField({ autocomplete: "section-a new-password" })).toBe(true);
    expect(isCredentialField({ autocomplete: "one-time-code" })).toBe(true);
    expect(isCredentialField({ autocomplete: "cc-csc" })).toBe(true);
    expect(isCredentialField({ autocomplete: "shipping  cc-exp" })).toBe(true);
  });

  test("ordinary fields are not", () => {
    expect(isCredentialField({})).toBe(false);
    expect(isCredentialField({ input_type: "text", autocomplete: "username" })).toBe(false);
    expect(isCredentialField({ input_type: null, autocomplete: null })).toBe(false);
    expect(isCredentialField({ autocomplete: "email acc-x" })).toBe(false);
  });
});
