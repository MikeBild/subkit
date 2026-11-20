import { describe, expect, test } from "bun:test";
import type { RequestStep } from "../types.ts";
import {
  alignFromEnd,
  applyStepProposal,
  baseDepth,
  commonFolder,
  contentCeiling,
  evidenceKind,
  folderSegments,
  MAX_LISTED_VALUES,
  observedContentBytes,
  observedKey,
  observedUrl,
  pageCeiling,
  pathTemplate,
  preferredEvidence,
  proposedRule,
  queryValue,
  rewriteObserved,
  runCeiling,
  type StepEvidence,
  splitQueryFromPath,
  textBytes,
  wholePathValue,
  wholePathVariable,
  wholePlaceholder,
  withoutOrigin,
} from "./boundary-derivation.ts";

const CLASSES = {
  identifier: /^[A-Za-z0-9_-]{1,200}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  integer: /^(0|[1-9][0-9]{0,18})$/,
  date: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
  timestamp: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/,
  file_name: /^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9]{1,16}$/,
};

const PLAIN = () => false;

const UUID_A = "8f14e45f-ceea-467a-87f3-b3b6e4d0f8a1";
const UUID_B = "2c1a3b44-5d6e-4f70-8192-a3b4c5d6e7f8";
const VAR = (name: string) => `\${${name}}`;

function evidence(overrides: Partial<StepEvidence> = {}): StepEvidence {
  return {
    url: null,
    key: null,
    prefix: null,
    pages: null,
    bytes: null,
    held: null,
    trial: false,
    prepared: null,
    execution_id: "run-1",
    version_id: "v1",
    at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("proposedRule", () => {
  test("nothing observed gives no rule, listed or not", () => {
    expect(proposedRule([], CLASSES, false, PLAIN)).toBeNull();
    expect(proposedRule([], CLASSES, true, PLAIN)).toBeNull();
  });

  test("the narrow classes win in their fixed order before any list", () => {
    expect(proposedRule([UUID_A, UUID_B], CLASSES, false, PLAIN)).toEqual({ class: "uuid" });
    expect(proposedRule(["2026-01-01T00:00:00Z"], CLASSES, false, PLAIN)).toEqual({
      class: "timestamp",
    });
    expect(proposedRule(["2026-01-01", "2026-02-01"], CLASSES, false, PLAIN)).toEqual({
      class: "date",
    });
    expect(proposedRule(["1", "20"], CLASSES, false, PLAIN)).toEqual({ class: "integer" });
  });

  test("a narrow class has to cover every value, not just one", () => {
    expect(proposedRule(["1", "en"], CLASSES, false, PLAIN)).toEqual({ enum: ["1", "en"] });
  });

  test("a handful of fixed words is listed, sorted and without repeats, before a wide class", () => {
    expect(proposedRule(["en", "de", "en"], CLASSES, false, PLAIN)).toEqual({ enum: ["de", "en"] });
    expect(proposedRule(["report.pdf"], CLASSES, false, PLAIN)).toEqual({ enum: ["report.pdf"] });
    expect(proposedRule(["v1_2-a.b"], CLASSES, false, PLAIN)).toEqual({ enum: ["v1_2-a.b"] });
  });

  test("the list ends at the readable maximum and the wide classes take over", () => {
    const words = Array.from({ length: MAX_LISTED_VALUES }, (_, index) => `word-${index}`);
    expect(proposedRule(words, CLASSES, false, PLAIN)).toEqual({ enum: [...words].sort() });
    expect(proposedRule([...words, "one-more"], CLASSES, false, PLAIN)).toEqual({
      class: "identifier",
    });
    const files = Array.from({ length: MAX_LISTED_VALUES + 1 }, (_, index) => `f${index}.json`);
    expect(proposedRule(files, CLASSES, false, PLAIN)).toEqual({ class: "file_name" });
  });

  test("a value a list cannot carry is neither listed nor classed", () => {
    expect(proposedRule(["a%2Fb"], CLASSES, false, PLAIN)).toBeNull();
    expect(proposedRule(["a b"], CLASSES, false, PLAIN)).toBeNull();
    expect(proposedRule([""], CLASSES, false, PLAIN)).toBeNull();
    expect(proposedRule(["ok", "a/b"], CLASSES, false, PLAIN)).toBeNull();
    expect(proposedRule(["x.".repeat(17)], CLASSES, false, PLAIN)).toBeNull();
    expect(proposedRule(["x".repeat(33)], CLASSES, false, PLAIN)).toEqual({ class: "identifier" });
    expect(proposedRule(["x".repeat(32)], CLASSES, false, PLAIN)).toEqual({
      enum: ["x".repeat(32)],
    });
    expect(proposedRule(["123:runReport"], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule(["a~b"], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule(["a+b"], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule([`${UUID_A}x`], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule(["prefix a"], CLASSES, false, PLAIN)).toBeNull();
    expect(proposedRule(["a suffix"], CLASSES, false, PLAIN)).toBeNull();
  });

  test("a value that looks like a secret is never listed, and a class is the only fallback", () => {
    const secret = (value: string) => value === "tok";
    expect(proposedRule(["tok", "en"], CLASSES, false, secret)).toEqual({ class: "identifier" });
    expect(proposedRule(["tok:en"], CLASSES, false, (value) => value === "tok:en")).toBeNull();
    expect(proposedRule(["tok", "en"], CLASSES, true, secret)).toBeNull();
    expect(proposedRule(["en", "de"], CLASSES, true, secret)).toEqual({ enum: ["de", "en"] });
  });

  test("listed-only never falls back to a class", () => {
    expect(proposedRule(["page-1"], CLASSES, true, PLAIN)).toEqual({ enum: ["page-1"] });
    expect(proposedRule(["x".repeat(33)], CLASSES, true, PLAIN)).toBeNull();
    const many = Array.from({ length: MAX_LISTED_VALUES + 1 }, (_, index) => `${index}`);
    expect(proposedRule(many, CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule(["a%2Fb"], CLASSES, true, PLAIN)).toBeNull();
  });

  test("an id shaped exactly like a UUID is listed although it is longer than a readable word", () => {
    expect(proposedRule([UUID_B, UUID_A, UUID_B], CLASSES, true, PLAIN)).toEqual({
      enum: [UUID_B, UUID_A],
    });
    expect(proposedRule([UUID_A, "page-1"], CLASSES, true, PLAIN)).toEqual({
      enum: [UUID_A, "page-1"],
    });
    expect(proposedRule([UUID_A, "en"], CLASSES, false, PLAIN)).toEqual({
      enum: [UUID_A, "en"],
    });
    expect(proposedRule([UUID_A, UUID_B], CLASSES, false, PLAIN)).toEqual({ class: "uuid" });
  });

  test("every other long value stays unlistable, and so does a UUID that reads as a secret", () => {
    expect(proposedRule([`${UUID_A}0`], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule([`0${UUID_A}`], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule([UUID_A.replace("8f14", "8g14")], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule([UUID_A.replaceAll("-", "_")], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule([UUID_A, "x".repeat(33)], CLASSES, true, PLAIN)).toBeNull();
    expect(proposedRule([UUID_A], CLASSES, true, (value) => value === UUID_A)).toBeNull();
    expect(proposedRule([UUID_A, UUID_B], CLASSES, true, (value) => value === UUID_B)).toBeNull();
    const { uuid: _uuid, ...unknown } = CLASSES;
    expect(proposedRule([UUID_A], unknown, true, PLAIN)).toBeNull();
  });

  test("a class the caller does not know is skipped", () => {
    const { uuid: _uuid, identifier: _identifier, ...partial } = CLASSES;
    expect(proposedRule(["7"], partial, false, PLAIN)).toEqual({ class: "integer" });
    const { integer: _integer, ...fewer } = partial;
    expect(proposedRule(["7"], fewer, false, PLAIN)).toEqual({ enum: ["7"] });
    const many = Array.from({ length: MAX_LISTED_VALUES + 1 }, (_, index) => `word-${index}`);
    expect(proposedRule(many, partial, false, PLAIN)).toBeNull();
  });
});

describe("ceilings", () => {
  test("content gets double the largest size, rounded up to a kibibyte, within the fixed range", () => {
    expect(contentCeiling(0)).toBe(1024);
    expect(contentCeiling(512)).toBe(1024);
    expect(contentCeiling(513)).toBe(2048);
    expect(contentCeiling(600)).toBe(2048);
    expect(contentCeiling(40_000)).toBe(80_896);
    expect(contentCeiling(6_000_000)).toBe(10_000_000);
  });

  test("pages get double the most fetched, at least five and at most a thousand", () => {
    expect(pageCeiling([])).toBeNull();
    expect(pageCeiling([0])).toBeNull();
    expect(pageCeiling([1])).toBe(5);
    expect(pageCeiling([3, 7, 2])).toBe(14);
    expect(pageCeiling([0, 4])).toBe(8);
    expect(pageCeiling([900])).toBe(1000);
  });

  test("calls get double the busiest run, at least one and at most ten thousand", () => {
    expect(runCeiling([])).toBe(1);
    expect(runCeiling(["a"])).toBe(2);
    expect(runCeiling(["a", "b", "a", "a", "b"])).toBe(6);
    expect(runCeiling(Array.from({ length: 6000 }, () => "a"))).toBe(10_000);
  });
});

describe("observed content", () => {
  test("text is measured in bytes, structures as their JSON, nothing as nothing", () => {
    expect(textBytes(undefined)).toBeNull();
    expect(textBytes(null)).toBeNull();
    expect(textBytes("")).toBe(0);
    expect(textBytes("äb")).toBe(3);
    expect(textBytes({ a: 1 })).toBe(7);
    expect(textBytes(() => 1)).toBeNull();
  });

  test("a measured size wins, then the held body, then the prepared size, then the reviewed body", () => {
    expect(observedContentBytes(evidence({ bytes: 40, held: { body: "abc" } }))).toBe(40);
    expect(observedContentBytes(evidence({ bytes: 0, held: { body: "abc" } }))).toBe(3);
    expect(observedContentBytes(evidence({ held: { body: "abc" } }))).toBe(3);
    expect(
      observedContentBytes(evidence({ held: { body: "abc" }, prepared: { body_bytes: 9 } })),
    ).toBe(3);
    expect(
      observedContentBytes(evidence({ held: { body: null }, prepared: { body_bytes: 9 } })),
    ).toBe(9);
    expect(
      observedContentBytes(
        evidence({
          prepared: { body_bytes: 9, redacted_request_json: JSON.stringify({ body: "abcdef" }) },
        }),
      ),
    ).toBe(9);
    expect(
      observedContentBytes(
        evidence({ prepared: { redacted_request_json: JSON.stringify({ body: { a: 1 } }) } }),
      ),
    ).toBe(7);
  });

  test("no usable source means no size", () => {
    expect(observedContentBytes(evidence())).toBeNull();
    expect(observedContentBytes(evidence({ prepared: {} }))).toBeNull();
    expect(
      observedContentBytes(evidence({ prepared: { redacted_request_json: "not json" } })),
    ).toBeNull();
    expect(
      observedContentBytes(evidence({ prepared: { redacted_request_json: "null" } })),
    ).toBeNull();
    expect(
      observedContentBytes(
        evidence({ prepared: { redacted_request_json: JSON.stringify({ body: null }) } }),
      ),
    ).toBeNull();
  });
});

describe("observed address", () => {
  test("the sent address wins, then the held one, then the prepared one", () => {
    expect(
      observedUrl(evidence({ url: "https://a", held: { url: "https://b" }, prepared: {} })),
    ).toBe("https://a");
    expect(
      observedUrl(evidence({ held: { url: "https://b" }, prepared: { url: "https://c" } })),
    ).toBe("https://b");
    expect(
      observedUrl(evidence({ url: "", held: { url: null }, prepared: { url: "https://c" } })),
    ).toBe("https://c");
    expect(observedUrl(evidence({ held: {}, prepared: {} }))).toBeNull();
    expect(observedUrl(evidence())).toBeNull();
  });

  test("a storage key is the sent key, or the held address without its leading slash", () => {
    expect(observedKey(evidence({ key: "a/b.json", held: { url: "/c/d.json" } }))).toBe("a/b.json");
    expect(observedKey(evidence({ held: { url: "/c/d.json" } }))).toBe("c/d.json");
    expect(observedKey(evidence({ held: { url: "//c/d.json" } }))).toBe("c/d.json");
    expect(observedKey(evidence({ held: { url: "c//d.json" } }))).toBe("c//d.json");
    expect(observedKey(evidence({ key: "", held: { url: "/" } }))).toBeNull();
    expect(observedKey(evidence({ held: { url: null } }))).toBeNull();
    expect(observedKey(evidence({ held: {} }))).toBeNull();
    expect(observedKey(evidence())).toBeNull();
  });

  test("evidence counts as sent once any request really left, otherwise as a trial", () => {
    expect(evidenceKind([evidence({ held: { url: "/a" } })])).toBe("trial");
    expect(evidenceKind([evidence({ prepared: { url: "https://a" } })])).toBe("trial");
    expect(evidenceKind([])).toBe("trial");
    expect(evidenceKind([evidence({ url: "https://a", trial: true })])).toBe("trial");
    expect(evidenceKind([evidence({ key: "a/b", trial: true })])).toBe("trial");
    expect(
      evidenceKind([evidence({ url: "https://a", trial: true }), evidence({ url: "https://a" })]),
    ).toBe("sent");
    expect(evidenceKind([evidence({ held: { url: "/a" } }), evidence({ url: "https://a" })])).toBe(
      "sent",
    );
    expect(evidenceKind([evidence({ key: "a/b" })])).toBe("sent");
    expect(evidenceKind([evidence({ prefix: "a/" })])).toBe("sent");
  });

  test("evidence of the reviewed version is preferred, and all of it is the fallback", () => {
    const rows = [{ version_id: "v1" }, { version_id: "v2" }, { version_id: null }];
    expect(preferredEvidence(rows, "v2")).toEqual([{ version_id: "v2" }]);
    expect(preferredEvidence(rows, "v3")).toEqual(rows);
    expect(preferredEvidence(rows, null)).toEqual([{ version_id: null }]);
    expect(preferredEvidence([], "v1")).toEqual([]);
  });
});

describe("path templates", () => {
  test("only a whole placeholder is a variable", () => {
    expect(wholePlaceholder(VAR("input.id"))).toBe("input.id");
    expect(wholePlaceholder(`x${VAR("a")}`)).toBeNull();
    expect(wholePlaceholder(`${VAR("a")}x`)).toBeNull();
    expect(wholePlaceholder(VAR(""))).toBeNull();
    expect(wholePlaceholder("plain")).toBeNull();
    expect(wholePlaceholder(7)).toBeNull();
    expect(wholePlaceholder([VAR("a")])).toBeNull();
  });

  test("an address authored with its origin is compared by its path alone", () => {
    expect(withoutOrigin("https://api.example.test/v1/pages")).toBe("/v1/pages");
    expect(withoutOrigin("custom+scheme-1.0://host:8080/a")).toBe("/a");
    expect(withoutOrigin("https://api.example.test")).toBe("");
    expect(withoutOrigin("/v1/https://x/y")).toBe("/v1/https://x/y");
    expect(withoutOrigin("1https://x/y")).toBe("1https://x/y");
    expect(withoutOrigin("https:/x/y")).toBe("https:/x/y");
    expect(withoutOrigin("://x/y")).toBe("://x/y");
    expect(withoutOrigin("h://x/y")).toBe("/y");
  });

  test("a path splits into literals and whole-segment variables", () => {
    expect(pathTemplate(`/v1/pages/${VAR("input.page_id")}`)).toEqual([
      "",
      "v1",
      "pages",
      { var: "input.page_id" },
    ]);
    expect(pathTemplate("")).toEqual([""]);
  });

  test("a path that cannot be compared is no template", () => {
    expect(pathTemplate(`/v1/page-${VAR("input.n")}`)).toBeNull();
    for (const mark of ["?", "#", "%", "\\"]) expect(pathTemplate(`/a${mark}b`)).toBeNull();
  });

  test("a template aligns with the end of the real address and yields its values", () => {
    const parts = pathTemplate(`/pages/${VAR("a")}/items/${VAR("b")}`) ?? [];
    expect(alignFromEnd(parts, "https://h.test/v2/pages/p1/items/i1")).toEqual(
      new Map([
        ["a", "p1"],
        ["b", "i1"],
      ]),
    );
    expect(alignFromEnd(parts, "https://h.test/pages/p1/items/i1")).toEqual(
      new Map([
        ["a", "p1"],
        ["b", "i1"],
      ]),
    );
  });

  test("a different literal, a shorter address or a broken address does not align", () => {
    const parts = pathTemplate(`/pages/${VAR("a")}`) ?? [];
    expect(alignFromEnd(parts, "https://h.test/posts/p1")).toBeNull();
    expect(alignFromEnd(parts, "not a url")).toBeNull();
    expect(alignFromEnd(pathTemplate("/a/b/c") ?? [], "https://h.test/c")).toBeNull();
    const three = pathTemplate(`/${VAR("a")}/${VAR("b")}/${VAR("c")}`) ?? [];
    expect(alignFromEnd(three, "https://h.test/x")).toBeNull();
    expect(alignFromEnd([""], "https://h.test/")).toBeNull();
    expect(alignFromEnd([], "https://h.test/")).toBeNull();
  });

  test("a template as long as the address aligns from its first segment", () => {
    expect(alignFromEnd(pathTemplate("//a") ?? [], "https://h.test/a")).toEqual(new Map());
    expect(alignFromEnd(pathTemplate(`${VAR("a")}/b`) ?? [], "https://h.test/b")).toEqual(
      new Map([["a", ""]]),
    );
  });

  test("a leading variable never absorbs a deeper address", () => {
    const parts = pathTemplate(`/${VAR("input.slug")}/edit`) ?? [];
    expect(alignFromEnd(parts, "https://h.test/blog/a/edit")).toBeNull();
    expect(alignFromEnd(pathTemplate("/blog/edit") ?? [], "https://h.test/x/blog/edit")).toEqual(
      new Map(),
    );
  });

  test("a single variable segment stands for the whole path", () => {
    expect(wholePathVariable(pathTemplate(VAR("item.path")) ?? [])).toBe("item.path");
    expect(wholePathVariable(pathTemplate(`/${VAR("item.path")}`) ?? [])).toBe("item.path");
    expect(wholePathVariable(pathTemplate(`/a/${VAR("item.path")}`) ?? [])).toBeNull();
    expect(wholePathVariable(pathTemplate("/a") ?? [])).toBeNull();
    expect(wholePathVariable([""])).toBeNull();
    expect(wholePathVariable([])).toBeNull();
  });

  test("the whole path of an address is its pathname", () => {
    expect(wholePathValue("https://h.test/de/datenstand/?x=1")).toBe("/de/datenstand/");
    expect(wholePathValue("nope")).toBeNull();
  });

  test("the base depth counts the path segments a connector already carries", () => {
    expect(baseDepth(null)).toBe(0);
    expect(baseDepth("")).toBe(0);
    expect(baseDepth("https://h.test")).toBe(0);
    expect(baseDepth("https://h.test/v2/api/")).toBe(2);
    expect(baseDepth("nope")).toBeNull();
  });
});

describe("query in the path", () => {
  test("a query written into the path is split into path and parameters", () => {
    expect(splitQueryFromPath(`/startups?page=${VAR("item.n")}&limit=10`)).toEqual({
      path: "/startups",
      query: { page: VAR("item.n"), limit: "10" },
    });
    expect(splitQueryFromPath("?a=1")).toEqual({ path: "", query: { a: "1" } });
    expect(splitQueryFromPath("/a?b=1&&c=x=y")).toEqual({
      path: "/a",
      query: { b: "1", c: "x=y" },
    });
    expect(splitQueryFromPath("/a?toString=1")).toEqual({ path: "/a", query: { toString: "1" } });
  });

  test("anything that is not a plain list of parameters is left alone", () => {
    expect(splitQueryFromPath("/a")).toBeNull();
    expect(splitQueryFromPath("/a=1")).toBeNull();
    expect(splitQueryFromPath("/a?")).toBeNull();
    expect(splitQueryFromPath("/a#x?b=1")).toBeNull();
    expect(splitQueryFromPath("/a?=1")).toBeNull();
    expect(splitQueryFromPath("/a?b")).toBeNull();
    expect(splitQueryFromPath(`/a?${VAR("k")}=1`)).toBeNull();
    expect(splitQueryFromPath(`/a?b=x${VAR("v")}`)).toBeNull();
    expect(splitQueryFromPath("/a?b=1&b=2")).toBeNull();
  });

  test("a rewrite counts only when a real request carried exactly these parameters", () => {
    const rewrite = { path: "/startups", query: { page: VAR("item.n"), limit: "10" } };
    const parts = pathTemplate(rewrite.path) ?? [];
    expect(rewriteObserved(rewrite, parts, ["https://h.test/startups?limit=10&page=2"])).toBe(true);
    expect(
      rewriteObserved(rewrite, parts, ["nope", "https://h.test/startups?page=2&limit=10"]),
    ).toBe(true);
    expect(rewriteObserved(rewrite, parts, [])).toBe(false);
    expect(rewriteObserved(rewrite, parts, ["nope"])).toBe(false);
    expect(rewriteObserved(rewrite, parts, ["https://h.test/other?page=2&limit=10"])).toBe(false);
    expect(rewriteObserved(rewrite, parts, ["https://h.test/startups?page=2&limit=20"])).toBe(
      false,
    );
    expect(rewriteObserved(rewrite, parts, ["https://h.test/startups?page=2"])).toBe(false);
    expect(
      rewriteObserved(rewrite, parts, ["https://h.test/startups?page=2&limit=10&sort=x"]),
    ).toBe(false);
    expect(rewriteObserved(rewrite, parts, ["https://h.test/startups?page=2&size=10"])).toBe(false);
    expect(
      rewriteObserved({ path: "/startups", query: { page: VAR("item.n") } }, parts, [
        "https://h.test/startups?other=2",
      ]),
    ).toBe(false);
    expect(
      rewriteObserved({ path: "/startups", query: { b: "1", a: "2" } }, parts, [
        "https://h.test/startups?a=2&b=1",
      ]),
    ).toBe(true);
  });

  test("a query value is read by its key", () => {
    expect(queryValue("https://h.test/a?lang=de", "lang")).toBe("de");
    expect(queryValue("https://h.test/a?lang=de", "page")).toBeNull();
    expect(queryValue("nope", "lang")).toBeNull();
  });
});

describe("folderSegments", () => {
  test("a key prefix is read folder by folder, without empty parts", () => {
    expect(folderSegments("v1/facts/year=2026/")).toEqual(["v1", "facts", "year=2026"]);
    expect(folderSegments("/v1//facts")).toEqual(["v1", "facts"]);
    expect(folderSegments("")).toEqual([]);
    expect(folderSegments("/")).toEqual([]);
  });
});

describe("commonFolder", () => {
  test("the deepest folder that holds every key", () => {
    expect(
      commonFolder(["v1/facts/year=2026/month=09/a.json", "v1/facts/year=2026/month=08/b.json"]),
    ).toBe("v1/facts/year=2026/");
    expect(commonFolder(["v1/a.json"])).toBe("v1/");
    expect(commonFolder(["/a", "/b"])).toBe("/");
    expect(commonFolder(["x/y/z", "x/yQ", "x/y/z"])).toBe("x/");
    expect(commonFolder(["x/y/z", "x/y/"])).toBe("x/y/");
  });

  test("keys without a shared folder have none", () => {
    expect(commonFolder([])).toBeNull();
    expect(commonFolder(["a.json"])).toBeNull();
    expect(commonFolder(["a/b.json", "c/d.json"])).toBeNull();
  });
});

describe("applyStepProposal", () => {
  const step = (extra: Record<string, unknown>) =>
    ({ id: "s", kind: "request", method: "GET", ...extra }) as unknown as RequestStep;

  test("a storage scope is merged into the declared one", () => {
    const applied = applyStepProposal(
      step({
        s3: { key: "x", scope: { key_prefix: "old/", max_bytes: 1, principal_bound: true } },
      }),
      { step_id: "s", s3_scope: { key_prefix: "new/", max_bytes: 2048, max_deletes: 4 } },
    );
    expect(applied.s3).toEqual({
      key: "x",
      scope: { key_prefix: "new/", max_bytes: 2048, max_deletes: 4, principal_bound: true },
    });
  });

  test("a storage scope is added where none was declared", () => {
    const applied = applyStepProposal(step({ s3: { key: "x" } }), {
      step_id: "s",
      s3_scope: { key_prefix: "new/", max_bytes: 2048 },
    });
    expect(applied.s3).toEqual({ key: "x", scope: { key_prefix: "new/", max_bytes: 2048 } });
  });

  test("a storage scope is ignored on a step that is not a storage step", () => {
    const plain = step({ path: "/a" });
    expect(
      applyStepProposal(plain, { step_id: "s", s3_scope: { key_prefix: "n/", max_bytes: 1 } }),
    ).toEqual(plain);
  });

  test("a request boundary, a page ceiling and a rewrite are all written", () => {
    const boundary = { variables: {}, max_body_bytes: 0, max_calls: 2 };
    const applied = applyStepProposal(
      step({ path: "/a?b=1", query: { keep: "yes" }, pagination: { strategy: "link" } }),
      {
        step_id: "s",
        boundary,
        max_pages: 6,
        path_rewrite: { path: "/a", query: { b: "1" } },
      },
    );
    expect(applied).toEqual(
      step({
        path: "/a",
        query: { keep: "yes", b: "1" },
        pagination: { strategy: "link", max_pages: 6 },
        boundary,
      }),
    );
  });

  test("a rewrite stays in the field the address was authored in", () => {
    const applied = applyStepProposal(step({ url: "https://h.test/a?b=1" }), {
      step_id: "s",
      path_rewrite: { path: "https://h.test/a", query: { b: "1" } },
    });
    expect(applied).toEqual(step({ url: "https://h.test/a", query: { b: "1" } }));
  });

  test("a page ceiling without pagination and an empty proposal change nothing", () => {
    const plain = step({ path: "/a" });
    expect(applyStepProposal(plain, { step_id: "s", max_pages: 6 })).toEqual(plain);
    expect(applyStepProposal(plain, { step_id: "s" })).toEqual(plain);
  });

  test("a proposal without a page ceiling keeps the declared one", () => {
    const paged = step({ path: "/a", pagination: { strategy: "link", max_pages: 5 } });
    const boundary = { variables: {}, max_body_bytes: 0, max_calls: 2 };
    expect(applyStepProposal(paged, { step_id: "s", boundary })).toEqual(
      step({ path: "/a", pagination: { strategy: "link", max_pages: 5 }, boundary }),
    );
  });
});
