import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import {
  type OnboardingProbeResult,
  type OnboardingSaveResult,
  type OnboardingTemplate,
  OnboardingWizard,
} from "../repl/onboarding-wizard.tsx";

const TEMPLATES: OnboardingTemplate[] = [
  {
    slug: "stripe",
    name: "Stripe",
    driver: "http",
    auth_type: "bearer",
    setup_instructions: "Generate a Secret Key from the Stripe dashboard.",
  },
  {
    slug: "github",
    name: "GitHub",
    driver: "http",
    auth_type: "bearer",
  },
];

async function tick(ms = 30): Promise<void> {
  // allow-wall-clock: ink's input parser needs a real macrotask gap
  // for keypress decoding (matches the journey-test convention used
  // in apps/subkit/src/tests/ink-app.test.tsx).
  await new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  cleanup();
});

describe("OnboardingWizard — happy path", () => {
  test("walks pick → credential → probe → save → done", async () => {
    const probeCalls: Array<{ template: string; credential: string }> = [];
    const saveCalls: Array<{ template: string; credential: string }> = [];
    const done: Array<{ status: string; reason?: string }> = [];

    const instance = render(
      <OnboardingWizard
        templates={TEMPLATES}
        onProbe={async (template, credential) => {
          probeCalls.push({ template: template.slug, credential });
          return { ok: true } satisfies OnboardingProbeResult;
        }}
        onSave={async (template, credential) => {
          saveCalls.push({ template: template.slug, credential });
          return {
            ok: true,
            connector_id: "conn-12345678-aaaa-bbbb-cccc-dddddddddddd",
          } satisfies OnboardingSaveResult;
        }}
        onDone={(result) => {
          done.push(result);
        }}
      />,
    );

    await tick();
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("onboarding wizard");
    expect(frame).toContain("Pick a template");
    expect(frame).toContain("Stripe");
    expect(frame).toContain("GitHub");

    instance.stdin.write("\r");
    await tick(20);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Enter the API token");

    instance.stdin.write("sk_test_12345");
    await tick(20);
    frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("sk_test_12345");
    expect(frame).toContain("•".repeat("sk_test_12345".length));

    instance.stdin.write("\r");
    await tick(60);

    expect(probeCalls).toEqual([{ template: "stripe", credential: "sk_test_12345" }]);
    expect(saveCalls).toEqual([{ template: "stripe", credential: "sk_test_12345" }]);

    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Connector created");
    expect(frame).toContain("/connectors list");

    instance.stdin.write("\r");
    await tick(20);
    expect(done).toHaveLength(1);
    expect(done[0]?.status).toBe("saved");
    instance.unmount();
  });

  test("↓ key moves the focused template before Enter", async () => {
    const probeCalls: Array<{ template: string }> = [];
    const instance = render(
      <OnboardingWizard
        templates={TEMPLATES}
        onProbe={async (template) => {
          probeCalls.push({ template: template.slug });
          return { ok: true };
        }}
        onSave={async () => ({ ok: true, connector_id: "c-1" })}
        onDone={() => {}}
      />,
    );
    await tick();
    instance.stdin.write("[B");
    await tick(20);
    instance.stdin.write("\r");
    await tick(20);
    instance.stdin.write("token");
    await tick(20);
    instance.stdin.write("\r");
    await tick(80);
    expect(probeCalls).toEqual([{ template: "github" }]);
    instance.unmount();
  });
});

describe("OnboardingWizard — failure recovery", () => {
  test("probe failure shows the reason and offers retry", async () => {
    let probeCalls = 0;
    const probeResults: OnboardingProbeResult[] = [
      { ok: false, reason: "401 Unauthorized" },
      { ok: true },
    ];
    const saveCalls: number[] = [];

    const instance = render(
      <OnboardingWizard
        templates={TEMPLATES}
        onProbe={async () => {
          const next = probeResults[probeCalls] ?? { ok: false, reason: "exhausted" };
          probeCalls += 1;
          return next;
        }}
        onSave={async () => {
          saveCalls.push(1);
          return { ok: true, connector_id: "c-2" };
        }}
        onDone={() => {}}
      />,
    );

    await tick();
    instance.stdin.write("\r");
    await tick(20);
    instance.stdin.write("token");
    await tick(20);
    instance.stdin.write("\r");
    await tick(60);

    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("probe failed: 401 Unauthorized");
    expect(frame).toContain("Enter to retry");
    expect(saveCalls).toHaveLength(0);

    instance.stdin.write("\r");
    await tick(80);
    expect(probeCalls).toBe(2);
    expect(saveCalls).toHaveLength(1);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Connector created");
    instance.unmount();
  });

  test("save failure shows the reason and offers retry", async () => {
    let saveCalls = 0;
    const saveResults: OnboardingSaveResult[] = [
      { ok: false, reason: "duplicate slug" },
      { ok: true, connector_id: "c-3" },
    ];

    const instance = render(
      <OnboardingWizard
        templates={TEMPLATES}
        onProbe={async () => ({ ok: true })}
        onSave={async () => {
          const next = saveResults[saveCalls] ?? { ok: false, reason: "exhausted" };
          saveCalls += 1;
          return next;
        }}
        onDone={() => {}}
      />,
    );

    await tick();
    instance.stdin.write("\r");
    await tick(20);
    instance.stdin.write("tok");
    await tick(20);
    instance.stdin.write("\r");
    await tick(80);

    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("save failed: duplicate slug");
    expect(frame).toContain("Enter to retry");
    expect(saveCalls).toBe(1);

    instance.stdin.write("\r");
    await tick(80);
    expect(saveCalls).toBe(2);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Connector created");
    instance.unmount();
  });

  test("Esc cancels the wizard with status: cancelled", async () => {
    const done: Array<{ status: string }> = [];
    const instance = render(
      <OnboardingWizard
        templates={TEMPLATES}
        onProbe={async () => ({ ok: true })}
        onSave={async () => ({ ok: true, connector_id: "c-4" })}
        onDone={(result) => {
          done.push(result);
        }}
      />,
    );
    await tick();
    instance.stdin.write("");
    await tick(40);
    expect(done).toEqual([{ status: "cancelled" }]);
    instance.unmount();
  });

  test("renders a no-templates fallback when the catalog is empty", async () => {
    const instance = render(
      <OnboardingWizard
        templates={[]}
        onProbe={async () => ({ ok: true })}
        onSave={async () => ({ ok: true })}
        onDone={() => {}}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("no connector templates available");
    instance.unmount();
  });
});
