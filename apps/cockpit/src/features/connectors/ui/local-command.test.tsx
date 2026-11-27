import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { EMPTY_LOCAL_COMMAND, EMPTY_TLS } from "../model/create-connector-model";
import { CommandConfirmBody, LocalCommandFieldset, TlsFieldset } from "./local-command";

describe("local command fields", () => {
  test("every field has a bound label and env rows name what they remove", () => {
    const html = render(
      <LocalCommandFieldset
        idPrefix="c"
        value={{
          ...EMPTY_LOCAL_COMMAND,
          env: [{ name: "API_TOKEN", value: "x", secret: true }],
        }}
        onChange={() => {}}
      />,
    );
    for (const id of ["c-command", "c-args", "c-cwd", "c-env-0-name", "c-env-0-value"])
      expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(html).toContain('aria-label="Variable API_TOKEN entfernen"');
    expect(html).toMatch(
      /id="c-env-0-value"[^>]*type="password"|type="password"[^>]*id="c-env-0-value"/,
    );
  });
});

describe("certificate options for a local https server", () => {
  test("the warning appears only when verification is off and is tied to the checkbox", () => {
    expect(
      render(<TlsFieldset idPrefix="t" value={EMPTY_TLS} onChange={() => {}} />),
    ).not.toContain("t-tls-skip-warning");
    const html = render(
      <TlsFieldset idPrefix="t" value={{ caPem: "", skipVerify: true }} onChange={() => {}} />,
      "en",
    );
    expect(html).toContain("Don’t verify certificate (local only)");
    expect(html).toContain('aria-describedby="t-tls-skip-warning"');
    expect(html).toMatch(/id="t-tls-skip-warning"[^>]*>SubKit then accepts any certificate/);
  });
});

describe("confirming a local command", () => {
  test("the dialog body shows the literal command line", () => {
    const html = render(<CommandConfirmBody line="docker mcp gateway run" testId="x" />);
    expect(html).toContain("Befehlszeile");
    expect(html).toMatch(/data-testid="x-line"[\s\S]*<code>docker mcp gateway run<\/code>/);
  });
});
