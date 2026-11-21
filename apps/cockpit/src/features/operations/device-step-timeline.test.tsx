import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { DeviceStepTimeline } from "./DeviceStepTimeline";
import type { DeviceStepRecord } from "./device-steps-model";

function render(steps: readonly DeviceStepRecord[], locale: Locale = "de"): string {
  const value: I18nValue = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  };
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <DeviceStepTimeline steps={steps} executionId="e1" />
    </I18nContext.Provider>,
  );
}

const STEPS: DeviceStepRecord[] = [
  { command_id: "c1", kind: "computer.open", target: "Numbers", state: "done", screenshot: false },
  {
    command_id: "c2",
    kind: "computer.key",
    target: "Rechnungen.numbers",
    state: "stopped",
    screenshot: false,
  },
];

describe("DeviceStepTimeline", () => {
  test("shows one compact line per device step with its state", () => {
    const html = render(STEPS);
    expect(html).toContain('aria-label="Auf dem Gerät"');
    expect(html).toContain('data-testid="device-steps-0"');
    expect(html).toContain("Öffnen · <span");
    expect(html).toContain("Erledigt");
    expect(html).toContain("Drücken · <span");
    expect(html).toContain("Gestoppt");
  });

  test("speaks English", () => {
    const html = render(STEPS, "en");
    expect(html).toContain("On the device");
    expect(html).toContain("Done");
    expect(html).toContain("Stopped");
  });

  test("a kept screenshot shows as a thumbnail with its description, others show none", () => {
    const html = render([
      { command_id: "s1", kind: "browser.screenshot", target: "", state: "done", screenshot: true },
      ...STEPS,
    ]);
    expect(html).toContain('data-testid="device-steps-0-thumbnail"');
    expect(html).toContain('src="/v1/executions/e1/device-steps/s1/screenshot');
    expect(html).toContain('alt="Geschwärztes Bildschirmfoto dieses Schritts"');
    expect(html).not.toContain("device-steps-1-thumbnail");
    expect(render(STEPS)).not.toContain("<img");
  });

  test("renders nothing for a run without device steps", () => {
    expect(render([])).toBe("");
  });
});
