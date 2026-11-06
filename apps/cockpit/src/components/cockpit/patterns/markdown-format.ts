export const MARKDOWN_FORMATS = [
  "heading",
  "bold",
  "italic",
  "list",
  "ordered",
  "link",
  "code",
  "reference",
] as const;

export type MarkdownFormat = (typeof MARKDOWN_FORMATS)[number];

interface MarkdownSelection {
  from: number;
  to: number;
}

interface MarkdownEdit {
  from: number;
  to: number;
  insert: string;
  selection: MarkdownSelection;
}

const LINK_TARGET = "https://";

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
}

function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end;
}

function wrap(text: string, range: MarkdownSelection, mark: string): MarkdownEdit {
  const selected = text.slice(range.from, range.to);
  const before = text.slice(Math.max(0, range.from - mark.length), range.from);
  const after = text.slice(range.to, range.to + mark.length);
  if (selected && before === mark && after === mark)
    return {
      from: range.from - mark.length,
      to: range.to + mark.length,
      insert: selected,
      selection: { from: range.from - mark.length, to: range.to - mark.length },
    };
  return {
    from: range.from,
    to: range.to,
    insert: `${mark}${selected}${mark}`,
    selection: {
      from: range.from + mark.length,
      to: range.from + mark.length + selected.length,
    },
  };
}

function prefixLines(
  text: string,
  range: MarkdownSelection,
  prefix: (index: number) => string,
  pattern: RegExp,
): MarkdownEdit {
  const from = lineStart(text, range.from);
  const to = lineEnd(text, range.to);
  const lines = text.slice(from, to).split("\n");
  const all = lines.every((line) => pattern.test(line));
  const insert = lines
    .map((line, index) => (all ? line.replace(pattern, "") : `${prefix(index)}${line}`))
    .join("\n");
  return { from, to, insert, selection: { from, to: from + insert.length } };
}

export function formatMarkdown(
  text: string,
  range: MarkdownSelection,
  format: MarkdownFormat,
): MarkdownEdit {
  const selection = {
    from: Math.max(0, Math.min(range.from, range.to, text.length)),
    to: Math.min(text.length, Math.max(range.from, range.to)),
  };
  const selected = text.slice(selection.from, selection.to);
  switch (format) {
    case "bold":
      return wrap(text, selection, "**");
    case "italic":
      return wrap(text, selection, "_");
    case "code":
      if (selected.includes("\n")) {
        const insert = `\`\`\`\n${selected}\n\`\`\``;
        return {
          from: selection.from,
          to: selection.to,
          insert,
          selection: { from: selection.from + 4, to: selection.from + 4 + selected.length },
        };
      }
      return wrap(text, selection, "`");
    case "heading":
      return prefixLines(text, selection, () => "## ", /^#{1,6} /);
    case "list":
      return prefixLines(text, selection, () => "- ", /^- /);
    case "ordered":
      return prefixLines(text, selection, (index) => `${index + 1}. `, /^\d+\. /);
    case "link": {
      const label = selected || "";
      const insert = `[${label}](${LINK_TARGET})`;
      const target = selection.from + label.length + 3;
      return {
        from: selection.from,
        to: selection.to,
        insert,
        selection: label
          ? { from: target, to: target + LINK_TARGET.length }
          : { from: selection.from + 1, to: selection.from + 1 },
      };
    }
    case "reference": {
      const needsSpace = selection.from > 0 && !/\s/.test(text.charAt(selection.from - 1));
      const insert = `${needsSpace ? " " : ""}@`;
      const caret = selection.from + insert.length;
      return {
        from: selection.from,
        to: selection.to,
        insert,
        selection: { from: caret, to: caret },
      };
    }
  }
}

export function applyMarkdownEdit(text: string, edit: MarkdownEdit): string {
  return `${text.slice(0, edit.from)}${edit.insert}${text.slice(edit.to)}`;
}
