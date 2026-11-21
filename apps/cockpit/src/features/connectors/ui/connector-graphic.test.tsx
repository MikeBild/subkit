import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { loadServiceMarks } from "@/lib/service-icons";
import { EMPTY_OAUTH_CLIENT } from "../model/create-connector-model";
import { ConnectionGraphic } from "./connector-graphic";
import { ConnectorSignInFields } from "./connector-sign-in-fields";

function graphic(tone: "ok" | "warn" | "error") {
  return render(
    <ConnectionGraphic
      workspace="Acme · Produktion"
      service={{ kind: "brand", key: "hubspot" }}
      serviceName="HubSpot"
      serviceLine="api.hubapi.com"
      way="account"
      wayLabel="Mit Konto"
      tone={tone}
      stateLine="Verbunden"
    />,
  );
}

describe("connection graphic", () => {
  test("shows SubKit, the way it signs in and the service with its host", async () => {
    await loadServiceMarks();
    const html = graphic("ok");
    expect(html).toContain("SubKit");
    expect(html).toContain("Acme · Produktion");
    expect(html).toMatch(/data-testid="connector-graphic-way"[^>]*>[\s\S]*Mit Konto/);
    expect(html).toContain("HubSpot");
    expect(html).toContain("api.hubapi.com");
    expect(html).toContain('data-slot="subkit-mark"');
    expect(html).toContain('src="data:image/svg+xml');
    expect(html).not.toMatch(/>H<\/span>/);
  });

  test("only the connecting line carries the state, never a card border", () => {
    const ok = graphic("ok");
    expect(ok).toMatch(/data-slot="connection-line"/);
    expect(ok).toContain("bg-emerald-500");
    expect(ok).not.toContain("border-emerald");
    const failed = graphic("error");
    expect(failed).toContain("border-dashed border-destructive");
    expect(failed.match(/border-destructive/g)?.length).toBe(1);
  });
});

describe("sign-in fields inside the wizard", () => {
  test("the wizard's cards replace the inline choice", () => {
    const html = render(
      <ConnectorSignInFields
        idPrefix="wizard"
        testId="signin"
        target="web"
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
      />,
    );
    expect(html).not.toContain('data-testid="signin"');
    expect(html).toContain('id="wizard-secret"');
  });
});
