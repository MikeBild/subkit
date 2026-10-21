import { describe, expect, test } from "bun:test";
import type { SortingState } from "@tanstack/react-table";
import { renderAction } from "./action-button";
import { ActionMenu } from "./action-menu";
import { Button } from "./button";
import { type CockpitColumn, DataTable, priorityClass } from "./data-table";
import { FactList } from "./fact-list";
import { FileDrop } from "./file-drop";
import { fileRefusal, formatBytes, parseCsv, previewKind } from "./file-kinds";
import { FilePreview } from "./file-preview";
import { FilterBar } from "./filter-bar";
import { PageHeader } from "./page-header";
import { rowChange, withLeaving } from "./row-motion";
import { StatusStrip } from "./status-strip";
import { SummaryLine } from "./summary-line";
import { render, renderInRouter } from "./test-utils";

type Row = { id: string; name: string; owner: string };

const columns: CockpitColumn<Row>[] = [
  { id: "name", header: "Name", accessorKey: "name" },
  { id: "owner", header: "Owner", accessorKey: "owner", meta: { priority: "low" } },
];

function table(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable<Row>
      columns={columns}
      data={[
        { id: "a", name: "Alpha", owner: "x" },
        { id: "b", name: "Beta", owner: "y" },
      ]}
      sorting={[] as SortingState}
      onSortingChange={() => {}}
      emptyState={{
        zero: { title: "none" },
        filtered: { title: "no match", description: "", resetLabel: "reset", onReset() {} },
      }}
      hasActiveFilters={false}
      columnsLabel="Columns"
      actionsLabel="Actions"
      collectionId="t"
      {...props}
    />,
  );
}

describe("DataTable", () => {
  test("a primary list reserves a real left filter column and keeps grouping in the list", () => {
    const html = table({
      toolbar: (
        <FilterBar
          search={{ value: "", onChange() {}, placeholder: "Suchen" }}
          selects={[
            {
              label: "Status",
              value: "all",
              onChange() {},
              options: [{ value: "all", label: "Alle" }],
            },
          ]}
        />
      ),
      groupingTabs: <span>Gruppierung</span>,
    });
    expect(html).toContain('data-family-slot="list-filter-panel"');
    expect(html).toContain("min-[1600px]:grid-cols-[280px_minmax(0,1fr)]");
    expect(html).toContain("min-[1600px]:pl-4");
    expect(html).toContain('data-slot="filter-panel"');
    expect(html).toContain('data-slot="filter-bar"');
    expect(html).toContain("Gruppierung");
    expect(html.indexOf('data-family-slot="list-filter-panel"')).toBeLessThan(
      html.indexOf("Gruppierung"),
    );
  });

  test("a list without a filter panel sits flush with its section", () => {
    const html = table();
    expect(html).not.toContain("min-[1600px]:px-4");
    expect(html).not.toContain("min-[1600px]:pl-4");
  });

  test("an embedded list also keeps its controls beside a narrowing filter column", () => {
    const html = table({
      collectionTier: "embedded",
      toolbar: (
        <>
          <FilterBar search={{ value: "", onChange() {}, placeholder: "Suchen" }} />
          <button type="button" data-testid="embedded-extra-action">
            Weitere Aktion
          </button>
        </>
      ),
    });
    expect(html).toContain('data-family-slot="list-filter-panel"');
    expect(html).toContain('data-slot="filter-panel"');
    expect(html).toContain("Weitere Aktion");
  });

  test("groups loaded rows on desktop and mobile without changing within-group order", () => {
    const html = table({
      data: [
        { id: "a", name: "Alpha", owner: "x" },
        { id: "b", name: "Beta", owner: "y" },
        { id: "c", name: "Gamma", owner: "x" },
      ],
      grouping: { getKey: (row) => row.owner },
      groupingTabs: <span>Group choices</span>,
    });
    const desktop = html.slice(
      html.indexOf('data-testid="t-desktop"'),
      html.indexOf('data-testid="t-mobile"'),
    );
    expect(desktop.indexOf("Alpha")).toBeLessThan(desktop.indexOf("Gamma"));
    expect(desktop.indexOf("Gamma")).toBeLessThan(desktop.indexOf("Beta"));
    expect((html.match(/data-slot="group-heading"/g) ?? []).length).toBe(4);
    expect(html).toContain("Group choices");
  });

  test("grouping tabs keep one spacing step above the table, empty states and cards", () => {
    const grouped = table({ groupingTabs: <span>Group choices</span> });
    expect(grouped).toContain('<div class="shrink-0 pb-3" data-family-slot="list-grouping">');
    const slot = grouped.indexOf('data-family-slot="list-grouping"');
    expect(slot).toBeLessThan(grouped.indexOf("Group choices"));
    expect(grouped.indexOf("Group choices")).toBeLessThan(
      grouped.indexOf('data-testid="t-desktop"'),
    );
    const empty = table({ data: [], groupingTabs: <span>Group choices</span> });
    expect(empty.indexOf('data-family-slot="list-grouping"')).toBeLessThan(empty.indexOf(">none<"));
    expect(table()).not.toContain('data-family-slot="list-grouping"');
  });

  test("has no pager and no visible record count", () => {
    const html = table();
    expect(html).not.toContain('data-family-slot="pagination"');
    expect(html).not.toContain("–");
    expect(html).toContain('data-testid="t-count"');
    expect(html).toContain("Ergebnisse: 2");
  });

  test("an endless list ends in a sentinel while there is more", () => {
    const more = table({
      infinite: { fetchNextPage() {}, hasNextPage: true, isFetchingNextPage: false },
    });
    expect(more).toContain('data-testid="t-more"');
    expect(more).toContain('data-testid="t-mobile-more"');
    const done = table({
      infinite: { fetchNextPage() {}, hasNextPage: false, isFetchingNextPage: false },
    });
    expect(done).not.toContain('data-testid="t-more"');
  });

  test("loading draws column-shaped rows at row height, invisible before the delay", () => {
    const html = table({ pending: true, skeletonRows: 4 });
    expect(html).toContain('data-testid="t-skeleton-row-3"');
    expect(html).not.toContain('data-testid="t-skeleton-row-4"');
    expect(html).toContain('data-loading-phase="reserve"');
    expect(html).toContain('data-slot="skeleton"');
  });

  test("the list measures its own width: cards when narrow, low-priority columns when wide", () => {
    expect(priorityClass("low")).toBe("hidden @4xl:table-cell");
    expect(priorityClass("high")).toBeUndefined();
    const html = table();
    expect(html).toContain("hidden @4xl:table-cell");
    expect(html).toContain("@4xl:block");
    expect(html).toContain("@4xl:hidden");
  });

  test("a phone card reads like a row: the name as link, then up to two facts without labels", () => {
    type Run = { id: string; name: string; kind: string; size: string; started: string };
    const html = render(
      <DataTable<Run>
        columns={[
          { id: "name", header: "Name", accessorKey: "name" },
          { id: "kind", header: "Kind", accessorKey: "kind" },
          { id: "started", header: "Started", accessorKey: "started", meta: { cardLabel: true } },
          { id: "size", header: "Size", accessorKey: "size" },
        ]}
        data={[{ id: "a", name: "Alpha", kind: "Web API", size: "12 KB", started: "today" }]}
        sorting={[] as SortingState}
        onSortingChange={() => {}}
        onOpen={() => {}}
        rowActions={() => (
          <button type="button" data-testid="r-row-menu">
            Menu
          </button>
        )}
        emptyState={{
          zero: { title: "none" },
          filtered: { title: "no match", description: "", resetLabel: "reset", onReset() {} },
        }}
        hasActiveFilters={false}
        columnsLabel="Columns"
        actionsLabel="Actions"
        collectionId="r"
      />,
    );
    const card = html.slice(html.lastIndexOf("<div", html.indexOf('data-testid="r-mobile-row-0"')));
    expect(card).toContain('data-family-slot="card-title"');
    expect(card).toContain('data-testid="r-mobile-row-link-0"');
    expect(card.match(/data-family-slot="card-fact"/g)).toHaveLength(2);
    expect(card).toContain("Web API");
    expect(card).toContain("Started today");
    expect(card).not.toContain("12 KB");
    expect(card).not.toContain(">Kind<");
    expect(card).not.toContain(">Name<");
    expect(card).toContain("span 3");
    expect(card).toContain("text-sm");
  });

  test("a pick list keeps its rows at every width and never turns into cards", () => {
    const html = table({ collectionTier: "embedded", layout: "rows" });
    expect(html).toContain('data-testid="t-desktop"');
    expect(html).not.toContain('data-testid="t-mobile"');
    expect(html).not.toContain("@4xl:block");
    expect(html).not.toContain("data-family-collection-mobile-card");
    expect(html).not.toContain("responsive-cards");
  });

  test("a list without search, toolbar or column picker draws no toolbar strip, only the count", () => {
    const embedded = table({ collectionTier: "embedded" });
    expect(embedded).not.toContain('data-family-slot="list-toolbar"');
    expect(embedded).toContain('data-testid="t-count"');
    expect(table()).toContain('data-family-slot="list-toolbar"');
  });
});

describe("row motion", () => {
  const rows = (ids: string[]) => ids.map((id) => ({ id, row: id }));

  test("a row inserted among known rows arrived; first rows and appended pages did not", () => {
    expect(rowChange(null, rows(["a", "b"])).arrived.size).toBe(0);
    expect([...rowChange(rows(["a", "b"]), rows(["n", "a", "b"])).arrived]).toEqual(["n"]);
    expect(rowChange(rows(["a", "b"]), rows(["a", "b", "c", "d"])).arrived.size).toBe(0);
  });

  test("a replaced list (search, filter) announces nothing", () => {
    const change = rowChange(rows(["a", "b", "c"]), rows(["x", "y", "a"]));
    expect(change.arrived.size).toBe(0);
    expect(change.left).toEqual([]);
  });

  test("a row that went fades where it stood", () => {
    const change = rowChange(rows(["a", "b", "c"]), rows(["a", "c"]));
    expect(change.left.map((entry) => [entry.id, entry.index])).toEqual([["b", 1]]);
    expect(withLeaving(["a", "c"], change.left)).toEqual([
      { row: "a", leaving: false },
      { row: "b", leaving: true },
      { row: "c", leaving: false },
    ]);
  });
});

describe("loading shapes", () => {
  test("PageHeader keeps title bar, badge and action placeholders, and an h1", async () => {
    const html = await renderInRouter(<PageHeader title="Läufe" loading />);
    expect(html).toContain('data-loading-phase="reserve"');
    expect(html).toContain("<h1");
    expect(html.match(/data-slot="skeleton"/g)?.length).toBe(3);
  });

  test("StatusStrip, SummaryLine and FactList draw their own shape", () => {
    expect(render(<StatusStrip tone="ok" line="x" loading />)).toContain(
      'data-loading-phase="reserve"',
    );
    expect(render(<SummaryLine text="x" loading />)).toContain('data-slot="skeleton"');
    const facts = render(<FactList items={[]} loading={3} />);
    expect(facts.match(/data-slot="skeleton"/g)?.length).toBe(6);
    expect(facts).not.toContain("<dl");
  });

  test("content without loading renders as before", () => {
    expect(render(<StatusStrip tone="ok" line="fine" />)).toContain("fine");
    expect(render(<FactList items={[{ label: "a", value: "b" }]} />)).toContain("<dl");
    const stacked = render(<FactList layout="stacked" items={[{ label: "a", value: "b" }]} />);
    expect(stacked).toContain('data-shape="stacked"');
    expect(stacked).toContain('class="space-y-3"');
  });

  test("Button keeps its label in place and shows a spinner", () => {
    const html = render(
      <Button pending data-testid="pending-button">
        Freigeben
      </Button>,
    );
    expect(html).toContain("invisible");
    expect(html).toContain("Freigeben");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
  });
});

describe("files", () => {
  test("each name and type previews as one kind", () => {
    expect(previewKind("a.png", "image/png")).toBe("image");
    expect(previewKind("logo.svg", "")).toBe("image");
    expect(previewKind("notes.md", "")).toBe("markdown");
    expect(previewKind("export.csv", "application/octet-stream")).toBe("csv");
    expect(previewKind("doc.pdf", "application/pdf")).toBe("pdf");
    expect(previewKind("data.json", "application/json")).toBe("text");
    expect(previewKind("archive.zip", "application/zip")).toBe("other");
  });

  test("the drop zone refuses by type and by size, and names which", () => {
    const png = { name: "a.png", type: "image/png", size: 10 };
    expect(fileRefusal(png, { accept: "image/*" })).toBeNull();
    expect(fileRefusal(png, { accept: ".csv,application/pdf" })).toBe("type");
    expect(fileRefusal({ name: "x.CSV", type: "", size: 1 }, { accept: ".csv" })).toBeNull();
    expect(fileRefusal(png, { maxBytes: 5 })).toBe("size");
  });

  test("CSV keeps quoted commas and quotes, and stops at the row limit", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n1,2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", "2"],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("h\n1\n2\n3", 2)).toEqual([["h"], ["1"]]);
  });

  test("sizes read as a person reads them", () => {
    expect(formatBytes(512, "en-US")).toBe("512 B");
    expect(formatBytes(3.4 * 1024 * 1024, "en-US")).toBe("3.4 MB");
  });

  test("the drop zone is a labelled file input; a stored PDF previews as a card", () => {
    const drop = render(<FileDrop onFiles={() => {}} accept=".csv" testId="drop" />);
    expect(drop).toContain('type="file"');
    expect(drop).toContain('data-testid="drop-input"');
    expect(drop).toContain("Datei hierher ziehen oder auswählen");
    const pdf = render(
      <FilePreview
        name="Rechnung.pdf"
        mimeType="application/pdf"
        size={2048}
        url="/f/1"
        testId="p"
      />,
    );
    expect(pdf).toContain('data-preview-kind="pdf"');
    expect(pdf).toContain('data-testid="p-open"');
    const csv = render(<FilePreview name="a.csv" text={"x,y\n1,2"} testId="c" />);
    expect(csv).toContain("<table");
  });

  test("a previewed document adds no h1 or h2 to the page", () => {
    const md = render(
      <FilePreview name="a.md" mimeType="text/markdown" text={"# Titel\n\n## Teil\n\nText"} />,
    );
    expect(md).not.toMatch(/<h[12][\s>]/);
    expect(md).toMatch(/<h3[^>]*>Titel</);
    expect(md).toMatch(/<h4[^>]*>Teil</);
  });
});

describe("actions", () => {
  test("a spec draws one button in the grammar; an element passes through", () => {
    const html = render(
      <StatusStrip
        tone="warn"
        line="Freigabe fehlt"
        action={{ label: "Freigeben", variant: "primary", testId: "go" }}
      />,
    );
    expect(html).toContain('data-testid="go"');
    expect(html).toContain('data-variant="default"');
    expect(html).toContain("max-sm:basis-full");
    expect(render(<>{renderAction(<span>own</span>)}</>)).toBe("<span>own</span>");
  });

  test("menu entries carry their data attributes", () => {
    const html = render(
      <ActionMenu
        items={[{ label: "Freigeben", testId: "one", data: { "data-opens": "approval" } }]}
      />,
    );
    expect(html).toContain('data-opens="approval"');
  });
});
