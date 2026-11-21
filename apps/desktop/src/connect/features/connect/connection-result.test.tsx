import { describe, expect, test } from "bun:test";
import { UiProvider } from "@ui/lib/ui-context";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopRunner } from "../../lib/test-runner.ts";
import {
  ConnectionOk,
  ConnectionProblem,
  type ConnectionProblemProps,
} from "./connection-result.tsx";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    <UiProvider lang="en" now={() => 0}>
      {element}
    </UiProvider>,
  );
}

const unreachable: ConnectionProblemProps = {
  tone: "danger",
  code: "unreachable",
  meta: "unknown.example.org",
  title: "Server not reachable",
  body: "No answer came from this address.",
  rows: [["Code", "unreachable"]],
  primary: { label: "Try again", onClick: () => {}, testId: "connection-retry" },
  secondary: { label: "Use the example", onClick: () => {}, testId: "connect-use-example" },
};

const count = (html: string, text: string) => html.split(text).length - 1;

describe.skipIf(!desktopRunner)("connection result", () => {
  test("a problem is the shared error card with the tried host, retry and the example", () => {
    const html = render(<ConnectionProblem {...unreachable} />);
    expect(html).toContain('data-slot="error-notice"');
    expect(html).toContain('data-tone="danger"');
    expect(count(html, "unknown.example.org")).toBe(1);
    expect(count(html, "Server not reachable")).toBe(1);
    expect(html).toContain('data-testid="connection-retry"');
    expect(html).toContain('data-testid="connect-use-example"');
  });

  test("the technical detail starts collapsed", () => {
    const html = render(<ConnectionProblem {...unreachable} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<dl");
  });

  test("without a second remedy only the retry shows", () => {
    const html = render(<ConnectionProblem {...unreachable} secondary={null} />);
    expect(html).not.toContain("Use the example");
  });

  test("a fitting server closes the link and shows only its version", () => {
    const html = render(<ConnectionOk title="Connected" chip="Version 11.2.0" />);
    expect(html).toContain("border-success/70");
    expect(html).toContain("Version 11.2.0");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("aria-expanded");
  });
});
