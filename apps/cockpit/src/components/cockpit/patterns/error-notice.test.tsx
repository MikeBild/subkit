import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/transport";
import { ErrorNotice, errorTechnicalRows, errorTechnicalText } from "./error-notice";
import { render } from "./test-utils";

const AT = new Date("2026-11-20T08:15:00.000Z");

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

  test("copies the rows as labelled lines", () => {
    const rows = errorTechnicalRows(new ApiError(500, { code: "internal" }, null), AT);
    expect(errorTechnicalText(rows, (key) => key.toUpperCase())).toBe(
      "CODE: internal\nHTTP: 500\nREQUEST: –\nTIME: 2026-11-20T08:15:00.000Z",
    );
  });

  test("renders what happened, what it means and a collapsed technical detail", () => {
    const html = render(
      <ErrorNotice
        title="The schedule could not be resumed"
        body="The schedule stays paused."
        error={new ApiError(500, { code: "internal" }, "trace-2")}
        testId="notice"
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The schedule could not be resumed");
    expect(html).toContain("The schedule stays paused.");
    expect(html).toContain("Technische Angaben");
    expect(html).toContain('data-testid="notice-technical-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("trace-2");
  });

  test("leaves the technical detail out when no failure is known", () => {
    const html = render(<ErrorNotice title="Not loaded" testId="notice" />);
    expect(html).not.toContain("notice-technical-toggle");
  });
});
