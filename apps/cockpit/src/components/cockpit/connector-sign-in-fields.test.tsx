import { describe, expect, test } from "bun:test";
import { ConnectorSignInFields } from "./connector-sign-in-fields";
import { EMPTY_OAUTH_CLIENT } from "./create-connector-model";
import { render } from "./patterns/test-utils";

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
