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
    const out = nameIdentifiers(`Run ${ID}.`, () => ({ label: "Monatsreport" }), HIDDEN);
    expect(out).toBe("Run Monatsreport.");
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

describe("nameIdentifiers — a bare identifier in backticks", () => {
  test("a span that is only an identifier is named, backticks and all", () => {
    const out = nameIdentifiers(`Connector-ID: \`${ID}\` (prod)`, known, HIDDEN);
    expect(out).toBe("Connector-ID: [Monatsreport](/cockpit/workflows/wf-1) (prod)");
    expect(out).not.toContain("`");
  });

  test("an unnameable one is masked rather than shown", () => {
    const out = nameIdentifiers(`Connector-ID: \`${OTHER}\``, known, HIDDEN);
    expect(out).toBe(`Connector-ID: ${HIDDEN}`);
    expect(out).not.toContain(OTHER);
  });

  test("a span carrying more than the identifier is still a payload", () => {
    const text = `Body: \`{"workflow_id":"${ID}"}\``;
    expect(nameIdentifiers(text, known, HIDDEN)).toBe(text);
  });

  test("a fenced block holding only an identifier is still a payload", () => {
    const text = "```\n" + ID + "\n```";
    expect(nameIdentifiers(text, known, HIDDEN)).toBe(text);
  });

  test("surrounding whitespace inside the span does not hide it", () => {
    const out = nameIdentifiers(`Die \` ${OTHER} \` davon`, known, HIDDEN);
    expect(out).toBe(`Die ${HIDDEN} davon`);
  });
});

describe("functional links survive identifier presentation", () => {
  const url = `https://engine.example.test/v1/connectors/${ID}/oauth/start?grant=test-token&state=${OTHER}#${ID}`;
  for (const text of [
    url,
    `[Gmail verbinden](${url})`,
    `<${url}>`,
    `**${url}**`,
    `[Öffnen](/v1/connectors/${ID}/oauth/start?grant=test-token)`,
    `[Öffnen](../connectors/${ID})`,
    `[Gmail][login]\n\n[login]: ${url}`,
  ]) {
    test(`preserves link target: ${text.slice(0, 45)}`, () => {
      expect(nameIdentifiers(text, known, HIDDEN)).toBe(text);
      expect(nameIdentifiers(text, () => null, HIDDEN)).toBe(text);
    });
  }
  test("still names prose surrounding a functional URL", () => {
    expect(nameIdentifiers(`Connector ${OTHER}: ${url} — Workflow ${ID}.`, known, HIDDEN)).toBe(
      `Connector ${HIDDEN}: ${url} — Workflow [Monatsreport](/cockpit/workflows/wf-1).`,
    );
  });
});
