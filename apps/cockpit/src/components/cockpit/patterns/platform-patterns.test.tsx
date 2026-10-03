// The platform layer of the patterns: loading shapes, endless lists, row
// motion and responsive columns.

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
    expect(html).toContain("@2xl:block");
    expect(html).toContain("@2xl:hidden");
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
