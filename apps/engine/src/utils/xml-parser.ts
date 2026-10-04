export function serializeXmlBody(value: unknown): string {
  const escapeText = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapeAttr = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const renderNode = (name: string, node: unknown): string => {
    if (node === null || node === undefined) return `<${name}/>`;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      return `<${name}>${escapeText(String(node))}</${name}>`;
    }
    if (Array.isArray(node)) {
      return node.map((entry) => renderNode(name, entry)).join("");
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const attrs: string[] = [];
      const children: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("@")) {
          attrs.push(`${k.slice(1)}="${escapeAttr(String(v ?? ""))}"`);
        } else if (k === "#text") {
          children.push(escapeText(String(v ?? "")));
        } else {
          children.push(renderNode(k, v));
        }
      }
      const head = attrs.length > 0 ? `${name} ${attrs.join(" ")}` : name;
      if (children.length === 0) return `<${head}/>`;
      return `<${head}>${children.join("")}</${name}>`;
    }
    return `<${name}>${escapeText(String(node))}</${name}>`;
  };
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" || Array.isArray(value)) {
    return renderNode("root", value);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [name, child] = entries[0]!;
    return renderNode(name, child);
  }
  return renderNode("root", value);
}

export function parseXmlBody(text: string): unknown {
  try {
    type XmlNode = string | { [k: string]: unknown };
    let i = 0;
    const len = text.length;
    const nsStack: Array<Record<string, string>> = [{}];

    const currentBindings = (): Record<string, string> => Object.assign({}, ...nsStack);

    const resolveNs = (qname: string): { prefix: string; local: string; uri: string | null } => {
      const idx = qname.indexOf(":");
      if (idx < 0) {
        const bindings = currentBindings();
        return { prefix: "", local: qname, uri: bindings[""] ?? null };
      }
      const prefix = qname.slice(0, idx);
      const local = qname.slice(idx + 1);
      const bindings = currentBindings();
      return { prefix, local, uri: bindings[prefix] ?? null };
    };

    const skipWhitespace = (): void => {
      while (i < len) {
        const ch = text[i]!;
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") i++;
        else break;
      }
    };

    const consumeProlog = (): void => {
      while (i < len) {
        skipWhitespace();
        if (text.startsWith("<?", i)) {
          const end = text.indexOf("?>", i + 2);
          if (end < 0) break;
          i = end + 2;
          continue;
        }
        if (text.startsWith("<!--", i)) {
          const end = text.indexOf("-->", i + 4);
          if (end < 0) break;
          i = end + 3;
          continue;
        }
        if (text.startsWith("<!DOCTYPE", i) || text.startsWith("<!doctype", i)) {
          const end = text.indexOf(">", i);
          if (end < 0) break;
          i = end + 1;
          continue;
        }
        break;
      }
    };

    const decodeEntities = (s: string): string =>
      s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");

    const parseAttrs = (raw: string): Record<string, string> => {
      const attrs: Record<string, string> = {};
      const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
        attrs[`@${m[1]}`] = decodeEntities(m[2] ?? m[3] ?? "");
      }
      return attrs;
    };

    const parseElement = (): { name: string; node: XmlNode } | null => {
      if (text[i] !== "<") return null;
      const tagEnd = text.indexOf(">", i);
      if (tagEnd < 0) return null;
      const tagBody = text.slice(i + 1, tagEnd).trim();
      const selfClosing = tagBody.endsWith("/");
      const inner = selfClosing ? tagBody.slice(0, -1).trim() : tagBody;
      const spaceIdx = inner.search(/\s/);
      const rawName = spaceIdx < 0 ? inner : inner.slice(0, spaceIdx);
      const attrPart = spaceIdx < 0 ? "" : inner.slice(spaceIdx + 1);
      const rawAttrs = parseAttrs(attrPart);

      const newBindings: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawAttrs)) {
        if (k === "@xmlns") {
          newBindings[""] = v;
        } else if (k.startsWith("@xmlns:")) {
          newBindings[k.slice("@xmlns:".length)] = v;
        }
      }
      nsStack.push(newBindings);

      const resolved = resolveNs(rawName);
      const name = resolved.prefix ? rawName : resolved.local;
      i = tagEnd + 1;

      if (selfClosing) {
        nsStack.pop();
        const node =
          Object.keys(rawAttrs).length > 0
            ? (rawAttrs as Record<string, unknown>)
            : (null as unknown as XmlNode);
        return { name, node };
      }

      const children: Record<string, unknown> = { ...rawAttrs };
      let textBuf = "";
      let closed = false;
      while (i < len) {
        if (text.startsWith("</", i)) {
          const end = text.indexOf(">", i + 2);
          if (end < 0) return null;
          i = end + 1;
          closed = true;
          break;
        }
        if (text.startsWith("<![CDATA[", i)) {
          const end = text.indexOf("]]>", i + 9);
          if (end < 0) return null;
          textBuf += text.slice(i + 9, end);
          i = end + 3;
          continue;
        }
        if (text.startsWith("<!--", i)) {
          const end = text.indexOf("-->", i + 4);
          if (end < 0) return null;
          i = end + 3;
          continue;
        }
        if (text[i] === "<") {
          const child = parseElement();
          if (!child) return null;
          const collidingAttr = `@${child.name}`;
          if (collidingAttr in children) {
            children[`@@${child.name}`] = children[collidingAttr];
            delete children[collidingAttr];
          }
          const existing = children[child.name];
          if (existing === undefined) {
            children[child.name] = child.node;
          } else if (Array.isArray(existing)) {
            existing.push(child.node);
          } else {
            children[child.name] = [existing, child.node];
          }
        } else {
          const next = text.indexOf("<", i);
          textBuf += text.slice(i, next < 0 ? len : next);
          i = next < 0 ? len : next;
        }
      }
      if (!closed) {
        nsStack.pop();
        return null;
      }
      nsStack.pop();
      const trimmed = decodeEntities(textBuf).trim();
      if (Object.keys(children).length === 0) {
        return { name, node: trimmed };
      }
      if (trimmed.length > 0) children["#text"] = trimmed;
      return { name, node: children };
    };

    consumeProlog();
    if (i >= len || text[i] !== "<") return null;
    const root = parseElement();
    if (!root) return null;
    return { [root.name]: root.node };
  } catch {
    return null;
  }
}
