import { bounded, MAX_ROWS, own, text } from "./limits.ts";

function escapeText(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
type TemplateNode = { text: string } | { path: string; children?: TemplateNode[] };
function parseTemplate(source: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: Array<{ path: string; children: TemplateNode[] }> = [{ path: "", children: root }];
  let offset = 0;
  for (const match of source.matchAll(/\{\{([#/]?)([\w.]+)\}\}/g)) {
    const current = stack[stack.length - 1];
    if (!current) throw new Error("Invalid template stack");
    const literal = source.slice(offset, match.index);
    if (/\{\{|\}\}/.test(literal)) throw new Error("Unsupported template syntax");
    current.children.push({ text: literal });
    const path = match[2] ?? "";
    if (match[1] === "#") {
      if (stack.length > 16) throw new Error("Template nesting limit exceeded");
      const node = { path, children: [] as TemplateNode[] };
      current.children.push(node);
      stack.push(node);
    } else if (match[1] === "/") {
      if (stack.length === 1 || current.path !== path)
        throw new Error("Mismatched template section");
      stack.pop();
    } else current.children.push({ path });
    offset = match.index + match[0].length;
  }
  const tail = source.slice(offset);
  if (stack.length !== 1 || /\{\{|\}\}/.test(tail)) throw new Error("Unsupported template syntax");
  root.push({ text: tail });
  return root;
}
export const template = Object.freeze({
  render(source: string, data: unknown, options: { mode?: "html" | "text" } = {}) {
    text(source);
    bounded(data);
    if (options.mode !== undefined && options.mode !== "html" && options.mode !== "text")
      throw new Error("Unknown template mode");
    let iterations = 0;
    const chunks: string[] = [];
    let length = 0;
    function append(value: string): void {
      length += value.length;
      if (length > 1_048_576) throw new Error("Template output limit exceeded");
      chunks.push(value);
    }
    function render(nodes: TemplateNode[], context: unknown): void {
      for (const node of nodes) {
        if (++iterations > 100_000) throw new Error("Template iteration limit exceeded");
        if ("text" in node) {
          append(node.text);
          continue;
        }
        const value = own(context, node.path);
        if (node.children) {
          if (!Array.isArray(value) || value.length > MAX_ROWS)
            throw new Error("Template section requires a bounded list");
          for (const item of value) render(node.children, item);
        } else {
          if (value !== null && typeof value === "object")
            throw new Error("Template value must be scalar");
          append(options.mode === "text" ? String(value ?? "") : escapeText(value));
        }
      }
    }
    render(parseTemplate(source), data);
    return chunks.join("");
  },
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const diff = Object.freeze({
  records(before: unknown[], after: unknown[], options: { key: string }) {
    if (
      !options?.key ||
      !Array.isArray(before) ||
      !Array.isArray(after) ||
      before.length > MAX_ROWS ||
      after.length > MAX_ROWS
    )
      throw new Error("Bounded records and explicit key required");
    bounded(before);
    bounded(after);
    function index(rows: unknown[]): Map<string | number, unknown> {
      const result = new Map<string | number, unknown>();
      for (const row of rows) {
        const key = own(row, options.key);
        if (
          (typeof key !== "string" && typeof key !== "number") ||
          (typeof key === "number" && !Number.isFinite(key))
        )
          throw new Error("Record key must be a string or finite number");
        if (result.has(key)) throw new Error("Duplicate record key");
        result.set(key, row);
      }
      return result;
    }
    const left = index(before);
    const right = index(after);
    return {
      added: [...right].filter(([key]) => !left.has(key)).map(([, value]) => value),
      removed: [...left].filter(([key]) => !right.has(key)).map(([, value]) => value),
      updated: [...right]
        .filter(([key, value]) => left.has(key) && canonical(left.get(key)) !== canonical(value))
        .map(([key, value]) => ({ key, before: left.get(key), after: value })),
    };
  },
});
