import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type AuthorityReviewPreview,
  authorityReviewModel,
} from "@/features/grants/model/authority-review-model";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { GrantEffectReview } from "./grant-effect-review";

type Effect = AuthorityReviewPreview["manifest"]["effects"][number];
const connector = "00000000-0000-4000-8000-000000000004";
const origin = "https://api.github.com";

function effect(step_id: string, path: string, method: "GET" | "POST" | "DELETE"): Effect {
  return {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    step_id,
    connector_id: connector,
    driver: "http",
    environment: "prod",
    request_digest: "d".repeat(64),
    target: `${origin}${path}`,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    operation: method,
    effect: method === "GET" ? "read" : method === "POST" ? "write" : "destructive",
    boundary: {
      base_url: origin,
      method,
      origin,
      segments: path
        .split("/")
        .map((part) => (part.startsWith("{") ? { var: `input.${part.slice(1, -1)}` } : part)),
      variables: path.includes("{issue}") ? { "input.issue": { class: "integer" } } : {},
      query: { fixed: {}, variable: [] },
      max_body_bytes: method === "POST" ? 65_536 : 0,
      max_calls: 5,
      ...(method === "DELETE" ? { destructive: true } : {}),
    },
  } as Effect;
}

const preview: AuthorityReviewPreview = {
  manifest: {
    schema_version: 1,
    tenant_id: "00000000-0000-4000-8000-000000000001",
    workflow_id: "00000000-0000-4000-8000-000000000002",
    workflow_version_id: "00000000-0000-4000-8000-000000000003",
    workflow_digest: "e".repeat(64),
    execution_environment: "prod",
    execution_options_digest: "c".repeat(64),
    effects: [
      effect("repo", "/repos/acme/app", "GET"),
      effect("comment", "/repos/acme/app/issues/{issue}/comments", "POST"),
      effect("purge", "/repos/acme/app/labels/stale", "DELETE"),
    ],
    issues: [],
  },
  approval_carries_over: false,
  schedules: [],
  boundary_growth: [
    {
      kind: "wider_effect",
      connector_id: connector,
      target: null,
      effect: "write",
      connector_name: "GitHub",
    },
  ],
  effect_changes: [
    { step_id: "purge", change: "unchanged", effect: "destructive", subject: "stale" },
    { step_id: "comment", change: "added", effect: "write", subject: "comments" },
    { step_id: "repo", change: "unchanged", effect: "read", subject: "app" },
  ],
  effect_changes_base: {
    workflow_version_id: "00000000-0000-4000-8000-000000000009",
    version: 12,
    approved: true,
  },
};

function render(
  locale: Locale,
  extra: { problems?: string[]; loading?: boolean; preview?: AuthorityReviewPreview } = {},
): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  const model = authorityReviewModel({
    preview: extra.preview ?? preview,
    connectorNames: new Map([[connector, "GitHub"]]),
    automation: { schedule: false, webhook: false },
    activation: true,
    carryOver: false,
  });
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <GrantEffectReview
        model={model}
        growth={preview.boundary_growth}
        problems={extra.problems ?? []}
        loading={extra.loading ?? false}
      />
    </I18nContext.Provider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("risk reads as a word next to each row in German", () => {
  const html = text(render("de"));
  expect(html).toContain("Kommentare");
  expect(html).toContain("Schreiben");
  expect(html).toContain("Destruktiv");
  expect(html).toContain("Lesen");
  expect(html).toContain("Gegenüber v12:");
  expect(html).toContain("1 neu");
  expect(html).toContain("Neu: schreibt an GitHub");
  expect(html).toContain("Beliebige issue");
  expect(html).toContain("Werte wie Datum oder Commit entstehen zur Laufzeit.");
});

test("the same review in English names the effects without raw digests", () => {
  const html = render("en");
  expect(text(html)).toContain("Comments");
  expect(text(html)).toContain("Write");
  expect(text(html)).toContain("Compared with v12:");
  for (const digest of ["a", "b", "c", "d", "e"]) expect(html).not.toContain(digest.repeat(64));
});

test("risky rows start open, others closed", () => {
  const html = render("en");
  const rows = [...html.matchAll(/<details([^>]*)data-testid="authority-effect-row-([a-z]+)"/g)];
  const open = Object.fromEntries(rows.map((match) => [match[2], / open=""/.test(match[1] ?? "")]));
  expect(open).toEqual({ purge: true, comment: true, repo: false });
});

test("problems show as an open error row; loading shows a skeleton", () => {
  expect(render("en", { problems: ["Step fetch is missing a target."] })).toContain(
    'data-testid="authority-review-problems"',
  );
  expect(render("en", { loading: true })).toContain('data-testid="authority-review-loading"');
});

test("a comparison with a running version that was never approved says so", () => {
  const unapproved: AuthorityReviewPreview = {
    ...preview,
    boundary_growth: undefined,
    effect_changes_base: {
      workflow_version_id: "00000000-0000-4000-8000-000000000009",
      version: 10,
      approved: false,
    },
  };
  expect(text(render("de", { preview: unapproved }))).toContain(
    "Gegenüber v10 (nicht freigegeben):",
  );
  expect(text(render("en", { preview: unapproved }))).toContain(
    "Compared with v10 (not approved):",
  );
});
