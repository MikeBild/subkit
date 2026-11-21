import { describe, expect, it } from "bun:test";
import { de } from "@ui/i18n/de";
import { type ErrorCatalog, errorMeta, requestId, techRows } from "@ui/lib/errors";
import { UiProvider } from "@ui/lib/ui-context";
import { ErrorNotice, ErrorState, FieldError, TechDetail } from "@ui/molecules/error-notice";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const AT = Date.UTC(2026, 10, 21, 9, 30, 0);
const fmt = (iso: string) => `at ${iso}`;
const CATALOG: ErrorCatalog = {
  cases: {
    unreachable: {
      meta: { cause: "timeout", code: "timeout", http: null },
      copy: { title: "Server nicht erreichbar", body: "Keine Antwort unter dieser Adresse." },
    },
    offline: {
      meta: { cause: "timeout", code: "server_offline", http: 503 },
      copy: { title: "Server offline", body: "Gerade läuft nichts." },
    },
    pageFailed: {
      meta: { cause: "unknown", code: "load_failed", http: 500 },
      copy: { title: "Die Seite ließ sich nicht anzeigen", body: "Die Daten kamen nicht an." },
    },
  },
  causes: { timeout: "Zeitüberschreitung", unknown: "Nicht eingeordnet" },
};
const html = (node: ReactNode, now = () => AT) =>
  renderToStaticMarkup(
    <UiProvider lang="de" fmt={fmt} now={now} server="https://app.example" errors={CATALOG}>
      {node}
    </UiProvider>,
  );

describe("error catalog fallback", () => {
  it("reads a case from the catalog the app hands in", () => {
    expect(errorMeta(CATALOG, "offline")).toEqual({
      cause: "timeout",
      code: "server_offline",
      http: 503,
    });
  });
  it("shows an unknown code neutrally instead of crashing", () => {
    expect(errorMeta(CATALOG, "server_too_old")).toEqual({
      cause: "unknown",
      code: "server_too_old",
      http: null,
    });
  });
});

describe("technical rows", () => {
  it("are pure: time and formatting come in as parameters", () => {
    const rows = techRows({
      kind: "offline",
      at: AT,
      catalog: CATALOG,
      labels: de.err,
      fmt,
      server: "srv",
    });
    expect(rows).toEqual([
      ["Ursache", "Zeitüberschreitung"],
      ["Code", "server_offline"],
      ["HTTP-Status", "503"],
      ["Anfrage-ID", requestId("offline", AT)],
      ["Zeit", `at ${new Date(AT).toISOString()}`],
      ["Server", "srv"],
    ]);
  });
});

describe("ErrorNotice", () => {
  it("renders an unknown code with the neutral copy", () => {
    const out = html(<ErrorNotice kind="not_an_app" />);
    expect(out).toContain(de.err.unknown.title);
    expect(out).toContain(de.err.unknown.body);
  });

  it("keeps the Lovable copy for a catalog case", () => {
    expect(html(<ErrorNotice kind="unreachable" />)).toContain("Server nicht erreichbar");
  });

  it("ErrorState accepts an unknown code too", () => {
    expect(
      html(<ErrorState kind="unreachable_host" onRetry={() => {}} onHome={() => {}} />),
    ).toContain(de.err.unknown.title);
  });
});

describe("TechDetail", () => {
  it("shows only the rows it is given", () => {
    const out = html(
      <TechDetail kind="unreachable" defaultOpen rows={[["Adresse", "https://x.example"]]} />,
    );
    expect(out).toContain("Adresse");
    expect(out).toContain("https://x.example");
    expect(out).not.toContain("Anfrage-ID");
  });

  it("falls back to the catalog rows with the injected clock", () => {
    const out = html(<TechDetail kind="offline" defaultOpen />);
    expect(out).toContain(`at ${new Date(AT).toISOString()}`);
    expect(out).toContain(requestId("offline", AT));
    expect(out).toContain("https://app.example");
  });

  it("prefers an explicit time over the clock", () => {
    const at = AT - 60_000;
    const out = html(<TechDetail kind="offline" defaultOpen at={at} />, () => {
      throw new Error("clock must not be read when `at` is given");
    });
    expect(out).toContain(`at ${new Date(at).toISOString()}`);
  });
});

describe("test ids", () => {
  const noop = () => {};

  it("ErrorNotice puts the root testId on the notice and derives remedy ids", () => {
    const out = html(
      <ErrorNotice
        kind="offline"
        testId="conn-error"
        primary={{ label: "Retry", onClick: noop }}
        secondary={{ label: "Details", onClick: noop }}
      />,
    );
    expect(out).toContain('data-testid="conn-error"');
    expect(out).toContain('data-testid="conn-error-primary"');
    expect(out).toContain('data-testid="conn-error-secondary"');
    expect(out).toContain('data-testid="conn-error-technical-toggle"');
  });

  it("a remedy's own testId wins over the derived one", () => {
    const out = html(
      <ErrorNotice
        kind="offline"
        testId="conn-error"
        primary={{ label: "Retry", onClick: noop, testId: "retry-now" }}
        secondary={{ label: "Help", onClick: noop, testId: "open-help" }}
      />,
    );
    expect(out).toContain('data-testid="retry-now"');
    expect(out).toContain('data-testid="open-help"');
    expect(out).not.toContain("conn-error-primary");
  });

  it("without testIds nothing is rendered", () => {
    const out = html(<ErrorNotice kind="offline" primary={{ label: "Retry", onClick: noop }} />);
    expect(out).not.toContain("data-testid");
  });

  it("TechDetail derives toggle, panel, copy and report ids from the root", () => {
    const out = renderToStaticMarkup(
      <UiProvider lang="en" now={() => AT} onReport={noop}>
        <TechDetail kind="offline" defaultOpen testId="conn-error" />
      </UiProvider>,
    );
    for (const id of ["technical-toggle", "technical", "technical-copy", "technical-report"])
      expect(out).toContain(`data-testid="conn-error-${id}"`);
  });

  it("ErrorState derives retry and home ids", () => {
    const out = html(
      <ErrorState kind="pageFailed" testId="page-error" onRetry={noop} onHome={noop} />,
    );
    expect(out).toContain('data-testid="page-error"');
    expect(out).toContain('data-testid="page-error-retry"');
    expect(out).toContain('data-testid="page-error-home"');
    expect(out).toContain('data-testid="page-error-technical-toggle"');
  });

  it("FieldError takes a testId", () => {
    expect(html(<FieldError testId="name-error">Required</FieldError>)).toContain(
      'data-testid="name-error"',
    );
  });
});

describe("technical detail layout", () => {
  const noop = () => {};
  const render = (layout?: "stacked" | "inline") =>
    renderToStaticMarkup(
      <UiProvider lang="en" now={() => AT} onReport={noop}>
        <TechDetail
          kind="unreachable"
          defaultOpen
          testId="signin-error"
          rows={[["Address", "https://a-very-long-host-name.example/with/a/path"]]}
          {...(layout ? { layout } : {})}
        />
      </UiProvider>,
    );

  it("defaults to the stacked Lovable layout with visible labels", () => {
    const out = render();
    expect(out).toContain('data-layout="stacked"');
    expect(out).toContain('class="mt-3 flex flex-wrap gap-2"');
    expect(out).toMatch(/<span>Copy<\/span>/);
    expect(out).toMatch(/<span>Report a bug<\/span>/);
  });

  it("inline puts compact icon buttons beside the facts, labels for screen readers only", () => {
    const out = render("inline");
    expect(out).toContain('data-layout="inline"');
    expect(out).not.toContain("mt-3 flex flex-wrap gap-2");
    expect(out).toMatch(/<span class="sr-only">Copy<\/span>/);
    expect(out).toMatch(/<span class="sr-only">Report a bug<\/span>/);
    expect(out).toContain('title="Copy"');
    expect(out).toContain("min-w-0 flex-1");
  });

  it("long values wrap inside the value cell in both layouts", () => {
    for (const out of [render(), render("inline")])
      expect(out).toContain("[overflow-wrap:anywhere]");
  });

  it("keeps the same test ids in both layouts", () => {
    for (const out of [render(), render("inline")])
      for (const id of ["technical-toggle", "technical", "technical-copy", "technical-report"])
        expect(out).toContain(`data-testid="signin-error-${id}"`);
  });

  it("ErrorNotice and ErrorState pass the layout through", () => {
    const html2 = (node: ReactNode) =>
      renderToStaticMarkup(
        <UiProvider lang="en" now={() => AT}>
          {node}
        </UiProvider>,
      );
    expect(html2(<ErrorNotice kind="unreachable" layout="inline" testId="n" />)).toContain(
      'data-testid="n-technical-toggle"',
    );
    expect(
      html2(
        <ErrorState kind="pageFailed" layout="inline" testId="s" onRetry={noop} onHome={noop} />,
      ),
    ).toContain('data-testid="s-technical-toggle"');
  });
});
