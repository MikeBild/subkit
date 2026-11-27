import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { EMPTY_OAUTH_CLIENT } from "../model/create-connector-model";
import { ConnectorSignInFields } from "./connector-sign-in-fields";

function fields(currentDetail?: string) {
  return (
    <ConnectorSignInFields
      idPrefix="edit"
      testId="signin"
      target="web"
      signIn={currentDetail ? null : "key"}
      onSignIn={() => {}}
      {...(currentDetail ? { currentDetail } : {})}
      secret=""
      onSecret={() => {}}
      keepsKey
      keepsClientSecret
      oauth={EMPTY_OAUTH_CLIENT}
      onOAuth={() => {}}
      callbackUrl={null}
    />
  );
}

describe("sign-in choice of an existing connector", () => {
  test("the kept sign-in is a short choice and its detail is the line under the control", () => {
    const html = render(fields("Schlüssel im Header Authorization, apikey"));
    const current = html.match(/data-testid="signin-current"[^>]*>([\s\S]*?)<\/button>/)?.[1];
    expect(current).toContain("Wie bisher");
    expect(current).not.toContain("Authorization");
    expect(html).toMatch(
      /data-testid="signin-description"[^>]*>Schlüssel im Header Authorization, apikey</,
    );
  });

  test("a new connector offers no kept sign-in and no detail line", () => {
    const html = render(fields());
    expect(html).not.toContain('data-testid="signin-current"');
    expect(html).not.toContain('data-testid="signin-description"');
  });

  test("the short choice has words in English too", () => {
    const html = render(fields("Key in the header Authorization, apikey"), "en");
    expect(html).toContain("As before");
  });
});

describe("a key for an MCP server", () => {
  function keyFields(keyMode: "bearer" | "header", locale: "de" | "en" = "de") {
    return render(
      <ConnectorSignInFields
        idPrefix="create"
        testId="signin"
        target="mcp"
        signIn="key"
        onSignIn={() => {}}
        secret=""
        onSecret={() => {}}
        keepsKey={false}
        keepsClientSecret={false}
        oauth={EMPTY_OAUTH_CLIENT}
        onOAuth={() => {}}
        callbackUrl={null}
        choice={false}
        keyMode={keyMode}
        onKeyMode={() => {}}
        header=""
        onHeader={() => {}}
      />,
      locale,
    );
  }

  test("Bearer is the first choice and asks for no header name", () => {
    const html = keyFields("bearer");
    expect(html).toContain('data-testid="signin-key-mode-bearer"');
    expect(html).toContain("Bearer-Token");
    expect(html).not.toContain('id="create-header-name"');
  });

  test("a custom header asks for its name with a bound label", () => {
    const html = keyFields("header", "en");
    expect(html).toMatch(/<label[^>]*for="create-header-name"[^>]*>Header name</);
    expect(html).toContain('id="create-header-name"');
  });
});
