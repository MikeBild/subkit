import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";
import { presentationValue } from "@/components/ai-elements/tool";

const files = [
  "apps/cockpit/src/app/**/*.tsx",
  "apps/cockpit/src/pages/**/*.tsx",
  "apps/cockpit/src/components/cockpit/**/*.tsx",
  "apps/cockpit/src/components/ai-elements/**/*.tsx",
].flatMap((pattern) => globSync(pattern));

const interactive = new Set([
  "Button",
  "AlertDialogAction",
  "AlertDialogCancel",
  "Checkbox",
  "ConfirmationAction",
  "DialogClose",
  "DropdownMenuItem",
  "DropdownMenuRadioItem",
  "DropdownMenuSubTrigger",
  "Input",
  "IconButton",
  "Link",
  "PromptInputSubmit",
  "PromptInputTextarea",
  "SelectItem",
  "SelectTrigger",
  "SidebarRail",
  "SidebarTrigger",
  "Suggestion",
  "TabsTrigger",
  "Textarea",
  "a",
  "button",
]);

describe("cockpit test selectors", () => {
  test("gives every rendered interactive element a stable selector", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function walk(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(parsed);
          const hasTestId = node.attributes.properties.some(
            (property) =>
              ts.isJsxAttribute(property) && property.name.getText(parsed) === "data-testid",
          );
          const delegates = node.attributes.properties.some(
            (property) =>
              ts.isJsxSpreadAttribute(property) ||
              (ts.isJsxAttribute(property) && property.name.getText(parsed) === "asChild"),
          );
          if (interactive.has(tag) && !hasTestId && !delegates) {
            const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
            offenders.push(`${file}:${line} <${tag}>`);
          }
        }
        ts.forEachChild(node, walk);
      }
      walk(parsed);
    }
    expect(offenders).toEqual([]);
  });

  test("does not put database identifiers into selectors", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(
        /data-testid[^\n]+\$\{[^}]*(?:row|conversation|selected|step)\.(?:id|tenant_id|conversation_id)\}/,
      );
    }
  });

  test("never falls back to a database identifier when a name is missing", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (/\?\?\s*[a-zA-Z_]+\.([a-z_]*_id|id)\b/.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("routes icon-only actions through the tooltip composition", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function walk(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (node.tagName.getText(parsed) === "Button") {
            const size = node.attributes.properties.find(
              (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === "size",
            );
            if (
              size &&
              ts.isJsxAttribute(size) &&
              size.initializer &&
              ts.isStringLiteral(size.initializer) &&
              size.initializer.text.startsWith("icon")
            ) {
              const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
              offenders.push(`${file}:${line}`);
            }
          }
        }
        ts.forEachChild(node, walk);
      }
      walk(parsed);
    }
    expect(offenders).toEqual([]);
  });

  test("does not use a database identifier as visible fallback text", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\?\?\s*(?:selected|step|row|conversation)\.id/);
      expect(source).not.toMatch(/<[^>]+>\{(?:selected|step|row|conversation)\.id\}<\//);
    }
  });

  test("removes identifiers from structured tool presentation", () => {
    const visible = JSON.stringify(
      presentationValue(
        {
          tenant_id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
          summary: "Record 018f4b4a-6d33-7b3a-9c2d-123456789abc is ready",
          nested: { workflow_id: "018f4b4a-6d33-7b3a-9c2d-123456789abc", name: "Monthly report" },
        },
        "reference hidden",
      ),
    );
    expect(visible).not.toContain("018f4b4a-6d33-7b3a-9c2d-123456789abc");
    expect(visible).not.toContain("tenant_id");
    expect(visible).not.toContain("workflow_id");
    expect(visible).toContain("Monthly report");
  });
});
