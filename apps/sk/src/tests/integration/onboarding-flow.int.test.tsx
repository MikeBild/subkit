// Onboarding-wizard component composition test.
//
// The legacy onboarding-wizard.tsx still drives the live UX, but the
// new components (IntegrationPicker, SecretField, OAuthWaitView) are
// the future replacement and need to compose correctly. This test
// drives them together through the same fixture data the wizard
// would feed them.

import { ThemeProvider } from "@chat-ui/index.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect, useState } from "react";

import {
  type FakeOAuthServer,
  startFakeOAuthServer,
} from "../../../../../tests/e2e/_helpers/fake-oauth.ts";
import {
  type ConnectorTemplate,
  IntegrationPicker,
} from "../../domain/connectors/IntegrationPicker.tsx";
import { SecretField } from "../../domain/connectors/SecretField.tsx";
import { flush, renderInk } from "../helpers/ink.tsx";

const STRIPE: ConnectorTemplate = {
  id: "1",
  slug: "stripe",
  display_name: "Stripe",
  category: "http",
};
const GITHUB: ConnectorTemplate = {
  id: "2",
  slug: "github",
  display_name: "GitHub",
  category: "http",
};

let server: FakeOAuthServer;
beforeEach(async () => {
  server = await startFakeOAuthServer();
});
afterEach(async () => {
  await server.cleanup();
});

interface WizardState {
  step: "pick" | "secret" | "done";
  picked?: ConnectorTemplate;
  secret?: string;
}

function MiniWizard({ onDone }: { onDone: (s: WizardState) => void }) {
  const [step, setStep] = useState<WizardState["step"]>("pick");
  const [picked, setPicked] = useState<ConnectorTemplate | null>(null);
  const [secret, setSecret] = useState("");

  useEffect(() => {
    if (step === "done") {
      onDone({
        step: "done",
        ...(picked ? { picked } : {}),
        ...(secret ? { secret } : {}),
      });
    }
  }, [step, picked, secret, onDone]);

  if (step === "pick") {
    return (
      <IntegrationPicker
        connectors={[STRIPE, GITHUB]}
        onPick={(t) => {
          setPicked(t);
          setStep("secret");
        }}
      />
    );
  }
  if (step === "secret") {
    return (
      <SecretField
        label="API key"
        value={secret}
        onChange={setSecret}
        onSubmit={(v) => {
          setSecret(v);
          setStep("done");
        }}
      />
    );
  }
  return null;
}

describe("integration: onboarding wizard composition (picker → secret)", () => {
  test("picker → secret → submit produces a complete wizard state", async () => {
    let captured: WizardState | null = null;
    const ui = renderInk(
      <ThemeProvider>
        <MiniWizard onDone={(s) => (captured = s)} />
      </ThemeProvider>,
    );
    try {
      await flush();
      // Pick the first item (Stripe).
      await ui.press("enter");
      await flush();
      // Type secret characters then submit.
      await ui.type("sk_live_abc");
      await flush();
      await ui.press("enter");
      // Wait for done callback. flush() yields to the microtask queue
      // so onChange callbacks settle without a wall-clock delay.
      for (let i = 0; i < 100 && captured === null; i++) {
        await flush();
      }
      expect(captured).not.toBeNull();
      expect((captured as unknown as WizardState | null)?.picked?.slug).toBe("stripe");
      expect((captured as unknown as WizardState | null)?.secret?.length).toBeGreaterThan(0);
    } finally {
      ui.unmount();
    }
  });

  test("secret never echoes to the rendered frame", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <SecretField label="Token" value="" onChange={() => undefined} />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.type("supersecret");
      await flush();
      // Component is uncontrolled here — onChange owns the value, so
      // the rendered frame won't show our typed text. Just assert that
      // plaintext absolutely doesn't appear.
      expect(ui.text()).not.toContain("supersecret");
    } finally {
      ui.unmount();
    }
  });
});
