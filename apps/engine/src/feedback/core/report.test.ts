import { describe, expect, test } from "bun:test";
import { feedbackBody, feedbackTitle } from "./report.ts";

describe("feedbackTitle", () => {
  test("names the kind and the first line", () => {
    expect(feedbackTitle("bug", "  Save does nothing\nsecond line")).toBe(
      "Bug report: Save does nothing",
    );
    expect(feedbackTitle("idea", "Dark tray icon")).toBe("Idea: Dark tray icon");
    expect(feedbackTitle("other", "Hello")).toBe("Feedback: Hello");
  });

  test("shortens a long first line", () => {
    const title = feedbackTitle("bug", "x".repeat(400));
    expect(title.length).toBe("Bug report: ".length + 120);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("feedbackBody", () => {
  test("names the address a report without sign-in may be answered at", () => {
    expect(
      feedbackBody({
        report_id: "r-2",
        kind: "bug",
        message: "Sign-in loops",
        redactions: 0,
        diagnostics: null,
        files: [],
        contact_email: "alex@example.test",
      }),
    ).toBe(
      [
        "Sign-in loops",
        "",
        "## Contact",
        "- Email: alex@example.test",
        "",
        "## Report",
        "- Kind: bug",
        "- Report id: r-2",
        "- Removed before storing: 0",
      ].join("\n"),
    );
  });

  test("renders message, report facts, diagnostics and attachments", () => {
    const body = feedbackBody({
      report_id: "r-1",
      kind: "bug",
      message: "Save does nothing",
      redactions: 2,
      diagnostics: {
        client_kind: "desktop",
        app_version: "0.1.0",
        route: "/cockpit/files",
        recent_errors: [{ code: "http_500", at: "2026-11-20T10:00:00.000Z" }],
      },
      files: [
        { id: "f-1", filename: "shot.png", content_type: "image/png", size_bytes: 2048 },
        { id: "f-2", filename: "a.txt", content_type: "text/plain; charset=utf-8", size_bytes: 12 },
      ],
    });
    expect(body).toBe(
      [
        "Save does nothing",
        "",
        "## Report",
        "- Kind: bug",
        "- Report id: r-1",
        "- Removed before storing: 2",
        "",
        "## Diagnostics",
        "- Client: desktop",
        "- App version: 0.1.0",
        "- Route: /cockpit/files",
        "- Recent errors:",
        "  - 2026-11-20T10:00:00.000Z http_500",
        "",
        "## Attachments",
        "- shot.png (image/png, 2 KB), file f-1",
        "- a.txt (text/plain, 12 B), file f-2",
      ].join("\n"),
    );
  });

  test("leaves out empty sections", () => {
    const body = feedbackBody({
      report_id: "r-2",
      kind: "idea",
      message: "More colors",
      redactions: 0,
      diagnostics: null,
      files: [],
    });
    expect(body).not.toContain("## Diagnostics");
    expect(body).not.toContain("## Attachments");
  });
});
