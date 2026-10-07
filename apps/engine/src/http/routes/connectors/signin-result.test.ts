import { describe, expect, test } from "bun:test";
import { SIGN_IN_FAILURES } from "../../../connectors/index.ts";
import { renderResultPage } from "../oauth/ui.ts";
import { signedInPage, signInFailedPage } from "./signin-result.ts";

const FACTS = {
  stored: "signed_in",
  name: "Example Mail",
  enabled: true,
  missing_scopes: [],
} as const;

const BACKLINK =
  "https://engine.example.org/cockpit/connectors/018f4b4a-6d33-7b3a-9c2d-1234567890c1";

const text = (page: { lines: readonly string[]; title: string; command?: string | null }) =>
  [page.title, ...page.lines, page.command ?? ""].join("\n");

describe("signedInPage", () => {
  test("each origin is sent back to its own surface and to no other", () => {
    const words = { cli: "terminal", chat: "conversation", portal: "close this page" } as const;
    for (const origin of ["cli", "chat", "portal"] as const) {
      const page = text(signedInPage("en", origin, FACTS, null));
      for (const [other, word] of Object.entries(words))
        expect(page.includes(word)).toBe(other === origin);
    }
  });

  test("German and English say the same things", () => {
    const facts = { ...FACTS, enabled: false, missing_scopes: ["a"] };
    const en = signedInPage("en", "chat", facts, null);
    const de = signedInPage("de", "chat", facts, null);
    expect(de.lines.length).toBe(en.lines.length);
    expect(de.title).toBe("Angemeldet");
    expect(de.lines[0]).toBe("„Example Mail“ ist angemeldet.");
  });

  test("says signed in and, when it is, switched off — the command only in a terminal flow", () => {
    const off = { ...FACTS, enabled: false };
    const cli = signedInPage("de", "cli", off, null);
    expect(text(cli)).toContain("abgeschaltet und bleibt es, bis ihn jemand einschaltet");
    expect(cli.command).toBe("sk connectors enable");
    for (const origin of ["chat", "portal", "cockpit"] as const)
      expect(signedInPage("de", origin, off, null).command).toBeNull();
    expect(text(signedInPage("de", "cli", FACTS, null))).not.toContain("abgeschaltet");
    expect(signedInPage("de", "cli", FACTS, null).command).toBeNull();
  });

  test("names the permissions the provider withheld", () => {
    const page = signedInPage(
      "en",
      "cli",
      { ...FACTS, missing_scopes: ["mail.read", "mail.send"] },
      null,
    );
    expect(text(page)).toContain("Missing: mail.read, mail.send.");
    expect(text(signedInPage("en", "cli", FACTS, null))).not.toContain("Missing");
  });

  test("a stored key is not called a sign-in", () => {
    const saved = signedInPage("en", "portal", { ...FACTS, stored: "credential_saved" }, null);
    expect(saved.title).toBe("Credential saved");
    expect(text(saved)).not.toContain("signed in");
    const received = signedInPage(
      "de",
      "portal",
      { ...FACTS, stored: "credential_received" },
      null,
    );
    expect(received.title).toBe("Zugangsdaten erhalten");
  });

  test("leads into the cockpit, onto the connector when it was given its address", () => {
    expect(signedInPage("en", "cli", FACTS, null).cockpitHref).toBe("/cockpit");
    expect(signedInPage("en", "cli", FACTS, BACKLINK).cockpitHref).toBe(BACKLINK);
    expect(
      signInFailedPage("de", "cockpit", "exchange_failed", { backlink: BACKLINK }).cockpitHref,
    ).toBe(BACKLINK);
  });
});

describe("signInFailedPage", () => {
  test("says nothing was stored and how to start over, per origin", () => {
    expect(text(signInFailedPage("en", "cli", "exchange_failed"))).toContain("from the terminal");
    expect(text(signInFailedPage("en", "chat", "exchange_failed"))).toContain(
      "fresh link in the conversation",
    );
    expect(text(signInFailedPage("de", "cockpit", "provider_declined"))).toContain(
      "auf der Seite des Konnektors",
    );
  });

  test("an unidentified flow names no surface", () => {
    const page = text(signInFailedPage("en", null, "link_expired"));
    expect(page).toContain("where you began it");
    for (const word of ["terminal", "conversation", "Cockpit"]) expect(page).not.toContain(word);
  });

  test("shows a provider's error code and nothing that is not one", () => {
    const shown = (code: string) =>
      text(signInFailedPage("en", "cli", "provider_declined", { provider_code: code }));
    expect(shown("access_denied")).toContain("Provider code: access_denied");
    for (const code of [
      "<script>alert(1)</script>",
      "Access Denied",
      "call +1 555 0100",
      "a".repeat(65),
      "",
    ])
      expect(shown(code)).not.toContain("Provider code");
  });

  test("a failure with no way to start over does not suggest one", () => {
    const gone = signInFailedPage("en", "portal", "connector_gone");
    expect(gone.lines).toEqual(["The connector this link belonged to no longer exists."]);
  });

  test("names the field that was empty", () => {
    const page = signInFailedPage("de", "portal", "missing_field", { field: "token" });
    expect(text(page)).toContain("Es fehlt: token");
  });
});

describe("the rendered page", () => {
  test("is the product's page shell, in the reader's language, with everything escaped", () => {
    const html = renderResultPage(
      signedInPage(
        "de",
        "cockpit",
        { ...FACTS, name: '<img src=x onerror="alert(1)">', enabled: false },
        `${BACKLINK}?x="><script>`,
      ),
      { locale: "de", scheme: "dark" },
    );
    expect(html).toContain('<html lang="de" class="dark">');
    expect(html).toContain('data-auth-contract="mcp-auth"');
    expect(html).toContain('data-result-kind="success"');
    expect(html).toContain("SubKit · Konnektor-Anmeldung");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("OAuth 2.1");
  });

  test("a failure is announced as one", () => {
    const html = renderResultPage(signInFailedPage("en", null, "link_expired"), {
      locale: "en",
      scheme: null,
    });
    expect(html).toContain('data-result-kind="error"');
    expect(html).toContain('role="alert"');
  });

  test("every result ends with exactly one link, into the cockpit", () => {
    const pages = [
      ...(["cli", "chat", "portal", "cockpit"] as const).map((origin) =>
        signedInPage("de", origin, FACTS, origin === "cockpit" ? BACKLINK : null),
      ),
      ...SIGN_IN_FAILURES.map((failure) => signInFailedPage("de", "chat", failure)),
    ];
    for (const page of pages) {
      const html = renderResultPage(page, { locale: "de", scheme: null });
      expect(html.match(/<a\s/g)?.length).toBe(1);
      expect(html).toContain(">Zum Cockpit</a>");
      expect(html).toContain(`href="${page.cockpitHref}"`);
      expect(html).toContain("<title>SubKit Cockpit</title>");
    }
  });

  test("a German result carries none of the English copy", () => {
    const english = (page: ReturnType<typeof signedInPage>) =>
      [page.title, ...page.lines].map((line) => line.replace(/“[^”]*”/, "").split(":")[0] ?? "");
    for (const failure of SIGN_IN_FAILURES) {
      const german = renderResultPage(signInFailedPage("de", "cli", failure, { field: "token" }), {
        locale: "de",
        scheme: null,
      });
      for (const line of english(signInFailedPage("en", "cli", failure, { field: "token" })))
        expect(german).not.toContain(line);
    }
    const german = renderResultPage(signedInPage("de", "cli", { ...FACTS, enabled: false }, null), {
      locale: "de",
      scheme: null,
    });
    for (const line of english(signedInPage("en", "cli", { ...FACTS, enabled: false }, null)))
      expect(german).not.toContain(line);
  });
});
