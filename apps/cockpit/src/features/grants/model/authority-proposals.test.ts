import { expect, test } from "bun:test";
import {
  proposalStepIds,
  proposalsModel,
  readBoundaryProposals,
} from "@/features/grants/model/authority-proposals";
import { CATALOGS } from "@/lib/i18n";

const number = (value: number) => `#${value}`;
const evidence = {
  observations: 2,
  sample: "https://api.example.test/v1/news",
  newest_at: "2026-01-01T00:00:00.000Z",
  kind: "sent" as const,
};
const pinned = { digest: "d".repeat(64), base_version_id: "version-1" };

const request = {
  step_id: "read_news",
  request: {
    method: "GET",
    origin: "https://api.example.test",
    segments: ["", "v1", "news"],
    variables: { "input.lang": { enum: ["de", "en"] } },
    query: { fixed: { limit: "10" }, variable: [{ key: "lang", var: "input.lang" }] },
    max_body_bytes: 0,
    max_calls: 4,
    pagination: { params: ["page"], max_requests: 14 },
  },
  evidence,
};

const storage = {
  step_id: "expire_cache",
  storage: {
    operation: "DELETE",
    key_prefix: "v1/cache/",
    max_bytes: 2048,
    max_keys: 1000,
    max_deletes: 6,
  },
  evidence: { ...evidence, observations: 1, sample: "v1/cache/", kind: "trial" as const },
};

test("a response of any shape reads as two lists with what pins them", () => {
  expect(readBoundaryProposals(null)).toEqual({
    proposals: [],
    unproposable: [],
    digest: "",
    base_version_id: null,
  });
  expect(readBoundaryProposals({ proposals: "x", unproposable: 3, digest: 4 })).toEqual({
    proposals: [],
    unproposable: [],
    digest: "",
    base_version_id: null,
  });
  const view = {
    proposals: [request],
    unproposable: [{ step_id: "s", reason: "no_history" }],
    ...pinned,
  };
  expect(readBoundaryProposals({ ...view, draft_version_id: "x" })).toEqual(view);
});

test("a proposed request limit is listed in plain words, the pattern stays technical", () => {
  const model = proposalsModel({ proposals: [request], unproposable: [], ...pinned }, number);
  expect(model.rows).toEqual([
    {
      step_id: "read_news",
      label: "Read news",
      title: "authority.boundary.read",
      destructive: false,
      lines: [
        { key: "authorityProposals.host", values: { host: "api.example.test" } },
        { key: "authority.boundary.variable", values: { name: "Lang", values: "de, en" } },
        { key: "authority.boundary.noBody", values: {} },
        { key: "authority.boundary.calls.other", values: { count: "#4" } },
        { key: "authority.boundary.paging.other", values: { params: "page", count: 14 } },
        { key: "authorityProposals.evidence.other", values: { count: 2 } },
      ],
      technical: "GET https://api.example.test/v1/news?limit=10&lang={input.lang}",
    },
  ]);
  expect(proposalStepIds(model)).toEqual(["read_news"]);
  const visible = model.rows
    .flatMap((row) => row.lines.flatMap((line) => Object.values(line.values)))
    .join(" ");
  expect(visible).not.toContain("input.lang");
  expect(visible).not.toContain("{");
});

test("only a proposal that lists values asks the reader to check them", () => {
  const model = (proposals: unknown[]) =>
    proposalsModel({ proposals, unproposable: [], ...pinned } as never, number);
  expect(model([request]).listsValues).toBe(true);
  expect(model([storage]).listsValues).toBe(false);
  const classed = {
    ...request,
    request: { ...request.request, variables: { "input.lang": { class: "identifier" } } },
  };
  expect(model([classed]).listsValues).toBe(false);
  expect(model([classed, request]).listsValues).toBe(true);
  for (const catalog of Object.values(CATALOGS)) {
    const text = (catalog as Record<string, string>)["authorityProposals.listedValues"] ?? "";
    expect(text.length).toBeGreaterThan(40);
    expect(text.match(/[.?](?=\s|$)/g) ?? []).toHaveLength(1);
    expect(text).not.toContain("!");
  }
});

test("a moved query is said in one sentence", () => {
  const moved = { ...request, path_rewrite: { path: "/v1/news", query: { limit: "10" } } };
  const [row] = proposalsModel({ proposals: [moved], unproposable: [], ...pinned }, number).rows;
  expect(row?.lines.at(-2)).toEqual({ key: "authorityProposals.rewrite", values: {} });
});

test("a proposed storage limit names its folder, its ceiling, its trial evidence and what it widens", () => {
  const widened = {
    ...storage,
    widens: [
      { field: "key_prefix" as const, from: "v1/old/", to: "v1/cache/" },
      { field: "max_bytes" as const, from: 1024, to: 2048 },
    ],
  };
  const model = proposalsModel({ proposals: [widened], unproposable: [], ...pinned }, number);
  expect(model.rows).toEqual([
    {
      step_id: "expire_cache",
      label: "Expire cache",
      title: "authority.storage.delete",
      destructive: true,
      lines: [
        { key: "authority.storage.folder", values: { folder: "v1/cache/" } },
        { key: "authority.storage.deleteScope.other", values: { count: "#6" } },
        {
          key: "authorityProposals.widens.key_prefix",
          values: { from: "v1/old/", to: "v1/cache/" },
        },
        { key: "authorityProposals.widens.max_bytes", values: { from: "#1024", to: "#2048" } },
        { key: "authorityProposals.evidence.trial.one", values: { count: 1 } },
      ],
      technical: "DELETE v1/cache/",
    },
  ]);
});

test("a proposal without a reviewable limit is not listed and not applied", () => {
  const model = proposalsModel(
    { proposals: [{ step_id: "bare", evidence }, request], unproposable: [], ...pinned },
    number,
  );
  expect(proposalStepIds(model)).toEqual(["read_news"]);
});

test("steps without a run are offered a trial, the rest keep a reason with its next step", () => {
  const model = proposalsModel(
    {
      proposals: [],
      unproposable: [
        { step_id: "never_ran", reason: "no_history" },
        { step_id: "store_report", reason: "body_size_unknown" },
        { step_id: "odd_path", reason: "path_not_comparable" },
        { step_id: "odd_values", reason: "values_not_describable" },
        { step_id: "sql_step", reason: "not_supported" },
        { step_id: "by_token", reason: "sensitive_value" },
        { step_id: "mail", reason: "still_refused", refusal: "stricter_profile_applies" },
        { step_id: "later", reason: "still_refused", refusal: "a_code_from_tomorrow" },
        { step_id: "newer", reason: "a_reason_from_tomorrow" },
      ],
      ...pinned,
    },
    number,
  );
  expect(model.rows).toEqual([]);
  expect(model.untried).toEqual([
    {
      step_id: "never_ran",
      label: "Never ran",
      reason: "authorityProposals.reason.no_history",
      code: "no_history",
    },
    {
      step_id: "store_report",
      label: "Store report",
      reason: "authorityProposals.reason.body_size_unknown",
      code: "body_size_unknown",
    },
  ]);
  expect(model.remaining.map((entry) => [entry.step_id, entry.reason, entry.code])).toEqual([
    ["odd_path", "authorityProposals.reason.path_not_comparable", "path_not_comparable"],
    ["odd_values", "authorityProposals.reason.values_not_describable", "values_not_describable"],
    ["sql_step", "authorityProposals.reason.not_supported", "not_supported"],
    ["by_token", "authorityProposals.reason.sensitive_value", "sensitive_value"],
    [
      "mail",
      "authority.refusal.stricter_profile_applies",
      "still_refused:stricter_profile_applies",
    ],
    ["later", "authorityProposals.reason.still_refused", "still_refused:a_code_from_tomorrow"],
    ["newer", "authorityProposals.reason.not_supported", "a_reason_from_tomorrow"],
  ]);
  for (const entry of [...model.untried, ...model.remaining])
    expect(Object.hasOwn(CATALOGS.en, entry.reason)).toBe(true);
});
