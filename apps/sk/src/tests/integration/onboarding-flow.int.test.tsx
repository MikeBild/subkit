import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
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
      await ui.press("enter");
      await flush();
      await ui.type("sk_live_abc");
      await flush();
      await ui.press("enter");
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
      expect(ui.text()).not.toContain("supersecret");
    } finally {
      ui.unmount();
    }
  });
});
