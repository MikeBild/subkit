import { describe, expect, test } from "bun:test";
import { renderInRouter } from "@/components/cockpit/patterns/test-utils";
import { FirstSteps } from "./first-steps";

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

describe("first steps", () => {
  test("the checklist counts what is done and points at the next step", async () => {
    const steps = [
      { title: "Dienst verbinden", line: "a", href: "/connectors", done: true },
      { title: "Workflow aus Vorlage", line: "b", href: "/workflows", done: false },
      { title: "Probe-Run starten", line: "c", href: "/workflows", done: false },
      { title: "Freigeben", line: "d", href: "/workflows", done: false },
    ];
    const html = await renderInRouter(
      <FirstSteps steps={steps} hidden={false} onHide={() => {}} />,
    );
    expect(html).toContain("Erste Schritte");
    expect(html).toContain("1 von 4 erledigt");
    expect(html).toContain('<ul class="divide-y" data-slot="start-steps">');
    expect(html).toContain('aria-valuenow="25"');
    expect(count(html, /aria-current="step"/g)).toBe(1);
    expect(html).toContain("Ausblenden");
    const finished = await renderInRouter(
      <FirstSteps
        steps={steps.map((step) => ({ ...step, done: true }))}
        hidden={false}
        onHide={() => {}}
      />,
    );
    expect(finished).not.toContain("Erste Schritte");
  });

  test("the checklist keeps no state of its own: hidden and without steps it renders nothing", async () => {
    const steps = [{ title: "Dienst verbinden", line: "a", href: "/connectors", done: false }];
    expect(await renderInRouter(<FirstSteps steps={steps} hidden onHide={() => {}} />)).toBe("");
    expect(await renderInRouter(<FirstSteps steps={[]} hidden={false} onHide={() => {}} />)).toBe(
      "",
    );
    const source = await Bun.file(new URL("./first-steps.tsx", import.meta.url)).text();
    expect(source).not.toMatch(/localStorage|useState/);
  });

  test("the connect step shows the first chosen service", async () => {
    const html = await renderInRouter(
      <FirstSteps
        steps={[
          {
            id: "connector",
            title: "Dienst verbinden",
            line: "a",
            href: "/connectors",
            done: false,
            service: "Gmail",
          },
        ]}
        hidden={false}
        onHide={() => {}}
      />,
    );
    expect(html).toContain(`data-slot="service-glyph"`);
    expect(html).toContain("fc413d");
    expect(html).not.toContain("lucide-plug");
  });
});
