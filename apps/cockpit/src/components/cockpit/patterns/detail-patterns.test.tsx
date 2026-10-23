import { describe, expect, test } from "bun:test";
import { schemaFields } from "@/lib/schema-form";
import { ChoiceCards } from "./choice-card";
import { DetailPage } from "./detail-page";
import { IconTile } from "./icon-tile";
import { MarkdownEditor } from "./markdown-editor";
import { OnboardingFrame, StartChecklist } from "./onboarding";
import { PageHeader } from "./page-header";
import { SchemaForm } from "./schema-form";
import { StatusStrip } from "./status-strip";
import { TabBody, TechnicalDetails } from "./tab-body";
import { TemplateCard, TemplateGrid } from "./template-card";
import { render, renderInRouter } from "./test-utils";
import { Timeline } from "./timeline";

const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;

describe("detail header", () => {
  test("title with category chip and actions share one row; the purpose sits below", async () => {
    const html = await renderInRouter(
      <PageHeader
        title="Tägliches Briefing"
        badge={<span data-x="chip">Devops</span>}
        purpose="Fasst offene Pull Requests zusammen."
        action={{ label: "Starten", variant: "primary", testId: "run" }}
        menu={<span data-x="menu" />}
        back={{ to: "/workflows", label: "Workflows" }}
      />,
    );
    expect(html).toContain('data-slot="page-header-grid"');
    expect(html).toContain("sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center");
    const row = html.indexOf('data-slot="page-title-row"');
    const actions = html.indexOf('data-slot="page-actions"');
    const purpose = html.indexOf('data-slot="page-purpose"');
    expect(row).toBeLessThan(actions);
    expect(actions).toBeLessThan(purpose);
    expect(html).toContain("order-last");
    expect(html).toContain("sm:col-span-2");
    expect(html.slice(row, actions)).toContain('data-x="chip"');
    expect(count(html, /<h1/g)).toBe(1);
  });

  test("a detail page stacks back, header, one strip and its tabs in one column", async () => {
    const html = await renderInRouter(
      <DetailPage
        testId="file-page"
        back={{ to: "/files", label: "Dateien" }}
        title="styleguide.md"
        strip={{ tone: "warn", line: "Wartet auf Freigabe" }}
        tabs={[
          { value: "preview", label: "Vorschau", content: <p>inhalt</p> },
          { value: "usage", label: "Verwendung", content: <p>genutzt</p> },
        ]}
      />,
    );
    expect(html).toContain('data-page-kind="detail"');
    expect(html).toContain("max-w-[1280px]");
    expect(html).toContain('data-testid="detail-back"');
    expect(count(html, /data-slot="status-strip"/g)).toBe(1);
    expect(html).toContain('data-testid="file-page-tabs"');
    expect(html.indexOf('data-slot="status-strip"')).toBeLessThan(
      html.indexOf('data-slot="page-tabs"'),
    );
  });

  test("a page without anything to say shows no strip", async () => {
    const html = await renderInRouter(
      <DetailPage testId="p" back={{ to: "/files", label: "Dateien" }} title="x" />,
    );
    expect(html).not.toContain('data-slot="status-strip"');
  });

  test("the strip shows its state by dot and words, not by a tinted frame", () => {
    for (const tone of ["ok", "info", "warn", "error"] as const) {
      const html = render(<StatusStrip tone={tone} line="x" />);
      const frame = html.match(/^<div[^>]*class="([^"]*)"/)?.[1] ?? "";
      expect(frame).toContain("border");
      expect(frame).not.toMatch(/(border|bg)-(destructive|amber|emerald|blue)/);
      expect(html).toContain(`data-tone="${tone}"`);
    }
  });
});

describe("tab body", () => {
  test("summary first, then one main element, then the rest, technical details last", () => {
    const html = render(
      <TabBody
        testId="usage"
        summary="So startest du ihn: im Cockpit und per Zeitplan."
        more={<span data-x="more" />}
        technical={<span data-x="raw" />}
      >
        <span data-x="main" />
      </TabBody>,
    );
    const order = [
      'data-slot="summary-line"',
      'data-x="main"',
      'data-x="more"',
      "Technische Angaben",
    ].map((marker) => html.indexOf(marker));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('data-state="closed"');
  });

  test("technical details are always closed and always named the same", () => {
    const html = render(
      <TechnicalDetails>
        <span>id</span>
      </TechnicalDetails>,
    );
    expect(html).toContain("Technische Angaben");
    expect(html).toContain('data-state="closed"');
    expect(render(<TechnicalDetails>x</TechnicalDetails>, "en")).toContain("Technical details");
  });
});

describe("timeline", () => {
  test("a dot on the line, the time in its gutter and a card per entry", () => {
    const html = render(
      <Timeline
        testId="runs"
        groups={[
          {
            label: "Heute",
            items: [
              {
                id: "r1",
                tone: "ok",
                time: "07:00",
                dateTime: "2026-10-22T07:00:00Z",
                title: "Erfolgreich",
                meta: "Zeitplan · 13 s",
                onOpen() {},
                label: "Lauf von 07:00 öffnen",
              },
              { id: "r2", tone: "error", time: "06:00", title: "Fehlgeschlagen" },
            ],
          },
          { label: "Leer", items: [] },
        ]}
      />,
    );
    expect(count(html, /data-slot="timeline-item"/g)).toBe(2);
    expect(count(html, /data-slot="timeline-group"/g)).toBe(1);
    expect(html).toContain("before:bg-border");
    expect(html).toContain('data-tone="ok"');
    expect(html).toContain('data-tone="error"');
    expect(html).toMatch(/<time dateTime="2026-10-22T07:00:00Z"/i);
    expect(count(html, /<button/g)).toBe(1);
    expect(html).toContain('aria-label="Lauf von 07:00 öffnen"');
    expect(html).not.toContain("Leer");
  });
});

describe("cards", () => {
  test("one icon tile shape, muted or outlined", () => {
    expect(render(<IconTile>i</IconTile>)).toContain("bg-muted");
    expect(render(<IconTile outline>i</IconTile>)).toContain("border bg-background");
  });

  test("choice cards use the icon tile and mark the chosen way", () => {
    const html = render(
      <ChoiceCards
        items={[
          {
            icon: <svg />,
            title: "Im Chat",
            line: "a",
            onSelect() {},
            testId: "a",
            selected: true,
          },
          {
            icon: <svg />,
            title: "Von Hand",
            line: "b",
            onSelect() {},
            testId: "b",
            selected: false,
          },
        ]}
      />,
    );
    expect(count(html, /data-slot="icon-tile"/g)).toBe(2);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("ring-foreground");
  });

  test("a template card names its services, trigger and effort; a link stays a link", () => {
    const html = render(
      <TemplateGrid>
        <TemplateCard
          title="Tägliches Briefing per E-Mail"
          line="Fasst jeden Morgen zusammen."
          icons={[<svg key="a" />, <svg key="b" />]}
          tag="Beliebt"
          meta={["Täglich 07:00", "ca. 5 Min."]}
          href="/workflows?template=brief"
          testId="tpl"
        />
      </TemplateGrid>,
    );
    expect(html).toContain('data-slot="template-grid"');
    expect(html).toMatch(/<a[^>]*href="[^"]*\/workflows\?template=brief"/);
    expect(count(html, /data-slot="icon-tile"/g)).toBe(2);
    expect(html).toContain("Beliebt");
    expect(html).toContain("ca. 5 Min.");
  });

  test("a template with one leading symbol puts it beside the name", () => {
    const html = render(
      <TemplateCard
        title="GitHub"
        line="Code, Pull Requests"
        lead={
          <IconTile outline>
            <svg />
          </IconTile>
        }
        testId="cn"
      />,
    );
    expect(html).toContain("flex-row items-start gap-3");
    expect(count(html, /data-slot="icon-tile"/g)).toBe(1);
    expect(html).not.toContain('data-slot="template-card-icons"');
  });
});

describe("onboarding", () => {
  test("a lead sentence above the ways to start", () => {
    const html = render(
      <OnboardingFrame lead="Ein Workflow erledigt wiederkehrende Arbeit." testId="start">
        <span data-x="ways" />
      </OnboardingFrame>,
    );
    expect(html.indexOf("wiederkehrende")).toBeLessThan(html.indexOf('data-x="ways"'));
  });

  test("the checklist counts what is done and points at the next step", async () => {
    const steps = [
      { title: "Dienst verbinden", line: "a", href: "/connectors", done: true },
      { title: "Workflow aus Vorlage", line: "b", href: "/workflows", done: false },
      { title: "Probelauf starten", line: "c", href: "/workflows", done: false },
      { title: "Freigeben", line: "d", href: "/workflows", done: false },
    ];
    const html = await renderInRouter(<StartChecklist steps={steps} />);
    expect(html).toContain("So startest du");
    expect(html).toContain("1 von 4 erledigt");
    expect(count(html, /aria-current="step"/g)).toBe(1);
    expect(html).toContain("Ausblenden");
    const finished = await renderInRouter(
      <StartChecklist steps={steps.map((step) => ({ ...step, done: true }))} />,
    );
    expect(finished).not.toContain("So startest du");
  });
});

describe("markdown editor", () => {
  test("toolbar, write/split/preview and the @ hint, labelled for screen readers", () => {
    const html = render(<MarkdownEditor label="Inhalt" value="## Regel" onChange={() => {}} />);
    for (const name of [
      "Überschrift",
      "Fett",
      "Kursiv",
      "Liste",
      "Link",
      "Code",
      "@ Verweis einfügen",
    ])
      expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain('role="toolbar"');
    expect(html).toContain("Schreiben");
    expect(html).toContain("Geteilt");
    expect(html).toContain("Vorschau");
    expect(html).toContain("@ fügt einen Verweis");
    expect(html).toContain("8 Zeichen");
    expect(html).not.toContain('data-slot="markdown-preview"');
  });

  test("the preview renders the markdown instead of showing it raw", () => {
    const html = render(
      <MarkdownEditor
        label="Inhalt"
        value={"## Regel\n\n- **duzen**"}
        defaultMode="preview"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('data-slot="markdown-preview"');
    expect(html).toMatch(/<h\d[^>]*>Regel</);
    expect(html).not.toContain("## Regel");
  });
});

describe("schema form", () => {
  const fields = schemaFields({
    type: "object",
    required: ["org"],
    properties: {
      org: { type: "string", title: "Organisation" },
      archived: { type: "boolean" },
      state: { type: "string", enum: ["open", "closed"] },
      tags: { type: "array", items: { type: "string" } },
      notify: { type: "object", properties: { email: { type: "string" } } },
    },
  });

  test("fields, a switch, choices, a list with add and a group, JSON only collapsed", () => {
    const html = render(
      <SchemaForm
        fields={fields}
        values={{ org: "", archived: false, state: "", tags: ["a"], notify: { email: "" } }}
        onChange={() => {}}
        errors={[{ path: "org", field: fields[0]!, problem: "missing" }]}
      />,
    );
    expect(html).toContain("Organisation");
    expect(html).toContain("Pflicht");
    expect(html).toContain('data-slot="switch"');
    expect(html).toContain('data-slot="segmented-control"');
    expect(html).toContain("Eintrag hinzufügen");
    expect(html).toContain('data-slot="schema-group"');
    expect(html).toContain("Organisation fehlt.");
    expect(html).toContain("Als JSON eingeben");
    expect(html).toContain('data-state="closed"');
    expect(html).not.toMatch(/<textarea/);
  });

  test("a schema without fields says so", () => {
    expect(
      render(
        <SchemaForm fields={[]} values={{}} onChange={() => {}} empty="Keine Angaben nötig." />,
      ),
    ).toContain("Keine Angaben nötig.");
  });
});
