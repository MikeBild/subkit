import { expect, test } from "bun:test";
import fc from "fast-check";
import { authorityHeadline, authorityVersionLabel } from "./authority-view";

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

test("authority view keeps version references and headline branches", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(authorityVersionLabel(id, new Map([[id, 7]]))).toEqual({ text: "v7", full: id });
  expect(authorityVersionLabel(id, new Map())).toEqual({ text: "00000000…", full: id });
  expect(authorityVersionLabel("named", new Map())).toEqual({ text: "named", full: null });
  expect(
    authorityHeadline(
      {
        execution_environment: "prod",
        valid_until: "future",
        until_label: "formatted",
        max_runs: 1,
      },
      t,
    ),
  ).toBe(
    'authority.production · authority.headline.until:{"until":"formatted"} · authority.headline.runs.one:{"max":1}',
  );
  expect(
    authorityHeadline(
      { execution_environment: "dev", valid_until: null, until_label: null, max_runs: null },
      t,
    ),
  ).toBe(
    "authority.development · authority.headline.untilRevoked · authority.headline.runs.unlimited",
  );
  expect(
    authorityHeadline(
      { execution_environment: "dev", valid_until: "invalid", until_label: null, max_runs: 2 },
      t,
    ),
  ).toBe('authority.development · authority.headline.runs.other:{"max":2}');
});

test("headline projection does not mutate supplied facts", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.option(fc.string(), { nil: null }),
      fc.option(fc.integer(), { nil: null }),
      (prod, until, max) => {
        const facts = Object.freeze({
          execution_environment: prod ? ("prod" as const) : ("dev" as const),
          valid_until: until,
          until_label: until,
          max_runs: max,
        });
        const before = JSON.stringify(facts);
        authorityHeadline(facts, t);
        expect(JSON.stringify(facts)).toBe(before);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
