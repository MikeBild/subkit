import { XMLParser, XMLValidator } from "fast-xml-parser";
import { bounded, text } from "./limits.ts";
export type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: (string | XmlNode)[];
};
function name(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) throw new Error("Invalid XML name");
  return value;
}
function escapeText(value: string): string {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
export const xml = Object.freeze({
  parse(source: string): XmlNode {
    text(source);
    if (/<!DOCTYPE|<!ENTITY/i.test(source))
      throw new Error("XML declarations and entities are disabled");
    const valid = XMLValidator.validate(source);
    if (valid !== true) throw new Error(`XML_INVALID: ${valid.err.code}`);
    const raw: unknown = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: true,
      ignoreDeclaration: true,
      ignorePiTags: true,
    }).parse(source);
    bounded(raw);
    function convert(items: Record<string, unknown>[]): (string | XmlNode)[] {
      return items.map((item) => {
        if (Object.hasOwn(item, "#text")) return String(item["#text"]);
        const tag = Object.keys(item).find((key) => key !== ":@");
        if (!tag || !Array.isArray(item[tag])) throw new Error("Unsupported XML node");
        return {
          name: name(tag),
          attributes: (item[":@"] ?? {}) as Record<string, string>,
          children: convert(item[tag] as Record<string, unknown>[]),
        };
      });
    }
    const roots = convert(raw as Record<string, unknown>[]).filter(
      (item) => typeof item !== "string" || item.trim() !== "",
    );
    if (roots.length !== 1 || typeof roots[0] === "string" || !roots[0])
      throw new Error("XML requires one root");
    return roots[0];
  },
  build(root: XmlNode): string {
    bounded(root);
    function serialize(node: XmlNode): string {
      const tag = name(node.name);
      const attributes = Object.keys(node.attributes)
        .sort()
        .map((key) => ` ${name(key)}="${escapeText(node.attributes[key] ?? "")}"`)
        .join("");
      return text(
        `<${tag}${attributes}>${node.children.map((child) => (typeof child === "string" ? escapeText(child) : serialize(child))).join("")}</${tag}>`,
      );
    }
    return serialize(root);
  },
});
