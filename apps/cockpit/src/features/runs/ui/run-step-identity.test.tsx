import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { stepCredentialSnapshots } from "../model/runs-model";
import { RunStepIdentityFacts } from "./runs-detail";

describe("recorded step identity facts", () => {
  test("shows each dispatched identity and recorded generation separately", () => {
    const snapshots = stepCredentialSnapshots({
      credential_snapshots: [
        {
          connector_id: "connector",
          environment: "prod",
          credential_generation: 3,
          access_token_version: null,
          identity: {
            subject: "recorded-reader",
            issuer: "https://issuer.example.test",
            source: "token_endpoint",
          },
        },
        {
          connector_id: "connector",
          environment: "dev",
          credential_generation: 5,
          access_token_version: null,
          identity: null,
        },
      ],
    });
    const html = render(
      <RunStepIdentityFacts
        snapshots={snapshots}
        connectorNames={new Map([["connector", "Mail"]])}
      />,
    );
    expect(html).toContain("recorded-reader");
    expect(html).toContain("https://issuer.example.test");
    expect(html).toContain("Mail");
    expect(html.match(/data-slot="fact-list"/g)).toHaveLength(2);
    expect(html).toContain("Echtbetrieb");
    expect(html).toContain(">Test</dd>");
    expect(html).toContain(">3</dd>");
    expect(html).toContain(">5</dd>");
    expect(html).toContain("Unbekannt");
  });

  test("a step without a recorded credential stays unknown", () => {
    const html = render(
      <RunStepIdentityFacts
        snapshots={[]}
        connectorNames={new Map([["connector", "Current account"]])}
      />,
    );
    expect(html).toContain("Unbekannt");
    expect(html).not.toContain("Current account");
    expect(html).not.toContain('data-slot="fact-list"');
  });
});
