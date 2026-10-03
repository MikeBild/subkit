import { FileText } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { formatBytes, parseCsv, previewKind } from "./file-kinds";
import { Skeleton } from "./skeleton";

/** The rows a CSV preview shows; the rest is the file's, not the preview's. */
export const CSV_PREVIEW_ROWS = 20;
/** The characters a text preview shows. */
const TEXT_PREVIEW_CHARS = 20_000;

type HeadingTag = "h3" | "h4" | "h5" | "h6";

/**
 * A previewed document sits under the page's h1 and a section's h2, so its own
 * headings move two levels down: its `#` renders as an h3, and no document ever
 * adds an h1 or h2 to the page's outline.
 */
function loweredHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${Math.min(level + 2, 6)}` as HeadingTag;
  return function LoweredHeading({
    node: _node,
    className,
    ...props
  }: ComponentProps<"h1"> & { node?: unknown }) {
    return (
      <Tag
        data-document-level={level}
        className={cn(
          "mt-4 mb-2 font-semibold first:mt-0",
          level === 1 ? "text-base" : "text-sm",
          className,
        )}
        {...props}
      />
    );
  };
}

const PREVIEW_COMPONENTS = {
  h1: loweredHeading(1),
  h2: loweredHeading(2),
  h3: loweredHeading(3),
  h4: loweredHeading(4),
  h5: loweredHeading(5),
  h6: loweredHeading(6),
};

/**
 * The one file preview (P21), for a picked file before upload and a stored
 * file after: an image as the image, Markdown rendered, text in a code block,
 * a CSV as a table of its first rows, a PDF (and anything else) as a card with
 * its name, size and a way to open it.
 *
 * Give it a `File` (a local pick: read in the browser, nothing is sent) or
 * the stored file's `url` and, for text kinds, its `text`.
 */
export function FilePreview({
  name,
  mimeType,
  size,
  file,
  url,
  text,
  testId,
}: {
  name: string;
  mimeType?: string | null;
  size?: number;
  file?: File;
  url?: string;
  /** The content of a stored text, Markdown or CSV file. */
  text?: string;
  testId?: string;
}) {
  const { t, locale } = useI18n();
  const kind = previewKind(name, mimeType ?? file?.type);
  const localText = useFileText(file, kind === "markdown" || kind === "text" || kind === "csv");
  const localUrl = useObjectUrl(file, kind === "image" || kind === "pdf");
  const content = text ?? localText;
  const href = url ?? localUrl;
  const bytes = size ?? file?.size;

  const frame = (body: ReactNode) => (
    <figure
      data-slot="file-preview"
      data-preview-kind={kind}
      data-testid={testId}
      className="flex min-w-0 flex-col gap-2"
    >
      {body}
      <figcaption className="truncate text-xs text-muted-foreground">
        {name}
        {bytes !== undefined ? ` · ${formatBytes(bytes, LOCALE_TAGS[locale])}` : ""}
      </figcaption>
    </figure>
  );

  if (kind === "image" && href)
    return frame(
      <img
        src={href}
        alt={name}
        className="max-h-96 w-auto max-w-full rounded-lg border object-contain"
      />,
    );
  if ((kind === "markdown" || kind === "text" || kind === "csv") && content === null)
    return frame(<Skeleton className="h-32 w-full" />);
  if (kind === "markdown" && content !== null)
    return frame(
      <div className="max-h-96 overflow-auto rounded-lg border p-4 text-sm">
        <Streamdown components={PREVIEW_COMPONENTS}>
          {content.slice(0, TEXT_PREVIEW_CHARS)}
        </Streamdown>
      </div>,
    );
  if (kind === "text" && content !== null)
    return frame(<CodeBlock code={content.slice(0, TEXT_PREVIEW_CHARS)} />);
  if (kind === "csv" && content !== null) {
    const [head = [], ...rows] = parseCsv(content, CSV_PREVIEW_ROWS + 1);
    return frame(
      <div className="max-h-96 overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              {head.map((cell, index) => (
                <TableHead key={index}>{cell}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {row.map((cell, index) => (
                  <TableCell key={index} className="max-w-64 truncate">
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>,
    );
  }
  // A PDF and anything else: a card that says what the file is and opens it.
  return (
    <div
      data-slot="file-preview"
      data-preview-kind={kind}
      data-testid={testId}
      className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
    >
      <FileText aria-hidden="true" className="size-8 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {kind === "pdf" ? "PDF" : (mimeType ?? file?.type ?? "")}
          {bytes !== undefined ? ` · ${formatBytes(bytes, LOCALE_TAGS[locale])}` : ""}
        </span>
      </span>
      {href ? (
        <Button variant="outline" size="sm" asChild>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid={testId ? `${testId}-open` : undefined}
          >
            {t("platform.file.open")}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/** A local file's text, read in the browser; null until read. */
function useFileText(file: File | undefined, wanted: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !wanted) return;
    let live = true;
    void file.text().then((value) => {
      if (live) setText(value);
    });
    return () => {
      live = false;
    };
  }, [file, wanted]);
  return text;
}

/** An object URL for a local file, revoked when the file or the preview goes. */
function useObjectUrl(file: File | undefined, wanted: boolean): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file || !wanted || typeof URL.createObjectURL !== "function") return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file, wanted]);
  return url;
}
