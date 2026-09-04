// The rule this pins: a payload survives, a sentence gets a name.
//
// Every case here was taken from an answer on a running installation, where
// masking every identifier turned request bodies into text that cannot work.

import { describe, expect, test } from "bun:test";
import { nameIdentifiers, splitCodeAndProse } from "./identifiers";

const ID = "5f47b19e-e8ec-42c7-b757-6dd4f1121ac1";
const OTHER = "a0404d03-4740-488d-83e1-10f36aa18460";
const HIDDEN = "interne Referenz";

const known = (id: string) =>
  id === ID ? { label: "Monatsreport", href: "/cockpit/workflows/wf-1" } : null;

describe("splitCodeAndProse", () => {
  test("a fenced block is one run, and the prose around it is not code", () => {
    const segments = splitCodeAndProse("davor\n```json\n{}\n```\ndanach");
    expect(segments.map((s) => s.code)).toEqual([false, true, false]);
    expect(segments[1]?.text).toBe("```json\n{}\n```");
  });

  test("an inline span is code", () => {
    expect(splitCodeAndProse("nimm `id` davon").map((s) => s.code)).toEqual([false, true, false]);
  });

  test("a backtick inside a fence does not open a span of its own", () => {
    const segments = splitCodeAndProse("```\nlet a = `x`\n```");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.code).toBe(true);
  });

  test("text without code is a single prose run", () => {
    expect(splitCodeAndProse("nur text")).toEqual([{ text: "nur text", code: false }]);
  });

  test("the pieces always join back to the original", () => {
    const text = "a `b` c\n```\nd\n```\ne";
    expect(
      splitCodeAndProse(text)
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });
});

describe("nameIdentifiers", () => {
  test("a request body keeps its identifier, byte for byte", () => {
    const text = `Sende \`{"workflow_id":"${ID}"}\` an die API.`;
    expect(nameIdentifiers(text, known, HIDDEN)).toContain(`"workflow_id":"${ID}"`);
  });

  test("a fenced payload keeps its identifier too", () => {
    const text = '```json\n{\n  "site_ids": ["' + ID + '"]\n}\n```';
    expect(nameIdentifiers(text, known, HIDDEN)).toBe(text);
  });

  test("a sentence gets the name as a link", () => {
    const out = nameIdentifiers(`Der Workflow ${ID} wurde gespeichert.`, known, HIDDEN);
    expect(out).toBe("Der Workflow [Monatsreport](/cockpit/workflows/wf-1) wurde gespeichert.");
  });

  test("a name without a place to go is still a name, not a phrase", () => {
    const out = nameIdentifiers(`Lauf ${ID}.`, () => ({ label: "Monatsreport" }), HIDDEN);
    expect(out).toBe("Lauf Monatsreport.");
  });

  test("an identifier nobody can name keeps the phrase", () => {
    expect(nameIdentifiers(`Connector ${OTHER} ist weg.`, known, HIDDEN)).toBe(
      `Connector ${HIDDEN} ist weg.`,
    );
  });

  test("prose and code in one message are treated differently", () => {
    const text = `Workflow ${ID} läuft. Body: \`{"id":"${ID}"}\``;
    const out = nameIdentifiers(text, known, HIDDEN);
    expect(out).toContain("[Monatsreport](/cockpit/workflows/wf-1) läuft");
    expect(out).toContain(`\`{"id":"${ID}"}\``);
  });

  test("a bracket in a name cannot break out of the link", () => {
    const out = nameIdentifiers(
      `Der Workflow ${ID}.`,
      () => ({ label: "Report [alt]", href: "/x" }),
      HIDDEN,
    );
    expect(out).toBe("Der Workflow [Report \\[alt\\]](/x).");
  });

  test("a message with no identifier is returned unchanged", () => {
    expect(nameIdentifiers("Nichts zu tun.", known, HIDDEN)).toBe("Nichts zu tun.");
  });
});
