import { describe, expect, test } from "bun:test";
import { listPageFailure } from "@ui/lib/errors";
import { ErrorNotice, ErrorState } from "@ui/molecules/error-notice";
import { ApiError } from "@/api/transport";
import { errorTechnicalRows, labelledTechnicalRows } from "@/lib/error-facts";
import { translate } from "@/lib/i18n";
import { DataState } from "./data-state";
import { Page } from "./page";
import { render } from "./test-utils";
import { useErrorNotice, usePageFailure } from "./use-error-detail";

const AT = new Date("2026-11-20T08:15:00.000Z");

function Notice({ withoutError = false }: { withoutError?: boolean }) {
  const notice = useErrorNotice({
    error: withoutError ? undefined : new ApiError(500, { code: "internal" }, "trace-2"),
    body: withoutError ? undefined : "The schedule stays paused.",
  });
  return (
    <ErrorNotice
      {...notice}
      title={withoutError ? "Not loaded" : "The schedule could not be resumed"}
      testId="notice"
    />
  );
}

function FailedPage() {
  const page = usePageFailure({
    onRetry: () => undefined,
    error: new ApiError(500, { code: "internal" }, "trace-3"),
    testId: "page",
  });
  return page ? <ErrorState {...page} heading="h2" /> : null;
}

describe("error notice", () => {
  test("lists code, HTTP status, request id and time of an API failure", () => {
    const error = new ApiError(409, { code: "schedule_paused", message: "paused" }, "trace-1");
    expect(errorTechnicalRows(error, AT)).toEqual([
      { key: "code", value: "schedule_paused" },
      { key: "http", value: "409" },
      { key: "request", value: "trace-1" },
      { key: "time", value: "2026-11-20T08:15:00.000Z" },
    ]);
  });

  test("marks what an unknown failure does not carry", () => {
    expect(errorTechnicalRows(new TypeError("offline"), AT).map((row) => row.value)).toEqual([
      "TypeError",
      "–",
      "–",
      "2026-11-20T08:15:00.000Z",
    ]);
    expect(errorTechnicalRows(new ApiError(0, null, null), AT)[1]?.value).toBe("–");
  });

  test("renders what happened, what it means and a collapsed technical detail", () => {
    const html = render(<Notice />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The schedule could not be resumed");
    expect(html).toContain("The schedule stays paused.");
    expect(html).toContain("Technische Einzelheit");
    expect(html).toContain('data-testid="notice-technical-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("trace-2");
  });

  test("leaves the technical detail out when no failure is known", () => {
    const html = render(<Notice withoutError />);
    expect(html).not.toContain("notice-technical-toggle");
  });

  test("a failed page shows the full error state: retry, back to the overview, technical detail", () => {
    const html = render(<FailedPage />);
    expect(html).toContain("Diese Seite ließ sich nicht anzeigen");
    expect(html).toContain('data-testid="page-retry"');
    expect(html).toContain('data-testid="page-home"');
    expect(html).toContain("Zur Übersicht");
    expect(html).toContain('data-testid="page-technical-toggle"');
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h1");
  });

  test("the report rows lead with the cause when the failure carries one", () => {
    const error = new ApiError(
      504,
      { code: "timeout", details: { cause_class: "provider_timeout" } },
      "t-4",
    );
    const rows = labelledTechnicalRows(error, AT, (key) => translate("de", key));
    expect(rows[0]?.[0]).toBe("Ursache");
    expect(rows.map(([label]) => label)).toContain("Code");
    const plain = labelledTechnicalRows(new TypeError("x"), AT, (key) => translate("de", key));
    expect(plain[0]?.[0]).toBe("Code");
  });
});

describe("page failure", () => {
  const onRetry = () => undefined;

  test("a list that failed before it had rows takes the page; a loaded one keeps it", () => {
    expect(
      listPageFailure({ failed: true, loaded: false, onRetry, collectionId: "tasks" }),
    ).toMatchObject({ testId: "tasks-error", retryTestId: "tasks-retry" });
    expect(
      listPageFailure({ failed: true, loaded: true, onRetry, collectionId: "tasks" }),
    ).toBeNull();
    expect(
      listPageFailure({ failed: false, loaded: false, onRetry, collectionId: "tasks" }),
    ).toBeNull();
  });

  test("the page frame shows only the error, in the same render, with retry and home", () => {
    const html = render(
      <Page
        kind="list"
        scroll="content"
        testId="p"
        header={<h1>Aufgaben</h1>}
        toolbar={<span>filter</span>}
        failure={listPageFailure({ failed: true, loaded: false, onRetry, collectionId: "tasks" })}
      >
        <span>rows</span>
      </Page>,
    );
    expect(html).toContain('data-testid="tasks-error"');
    expect(html).toContain('data-testid="tasks-retry"');
    expect(html).toContain('data-testid="tasks-error-home"');
    expect(html).toContain("Diese Seite ließ sich nicht anzeigen");
    expect(html).not.toContain("Aufgaben");
    expect(html).not.toContain("filter");
    expect(html).not.toContain("rows");
  });
});

describe("data state errors", () => {
  test("a section error keeps its line slot, its retry and the technical detail", () => {
    const html = render(
      <DataState
        state="error"
        line="Not loaded"
        onRetry={() => undefined}
        error={new ApiError(500, { code: "internal" }, "trace-5")}
        testId="ds"
      />,
    );
    expect(html).toContain('data-slot="data-state-line"');
    expect(html).toContain('data-testid="ds-retry"');
    expect(html).toContain('data-testid="ds-technical-toggle"');
  });

  test("a page-scoped error is the full error state", () => {
    const html = render(
      <DataState state="error" scope="page" onRetry={() => undefined} testId="ds" />,
    );
    expect(html).toContain('data-testid="ds-error"');
    expect(html).toContain('data-testid="ds-retry"');
    expect(html).toContain('data-testid="ds-error-home"');
  });
});
