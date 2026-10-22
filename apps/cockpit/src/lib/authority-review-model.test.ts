import { expect, test } from "bun:test";
import {
  type AuthorityReviewPreview,
  authorityReviewModel,
  replacedVersion,
  reviewTitle,
} from "@/lib/authority-review-model";
import { translate } from "@/lib/i18n";

type Effect = AuthorityReviewPreview["manifest"]["effects"][number];

const connector = "00000000-0000-4000-8000-000000000004";
const origin = "https://api.github.com";

function effect(
  step_id: string,
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    effect?: Effect["effect"];
    max_calls?: number;
    max_requests?: number;
    variables?: Record<string, { class: string } | { enum: string[] } | { caller_bound: true }>;
  } = {},
): Effect {
  const method = options.method ?? "GET";
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
    effect: options.effect ?? (method === "GET" ? "read" : "write"),
    boundary: {
      base_url: origin,
      method,
      origin,
      segments: path
        .split("/")
        .map((part) => (part.startsWith("{") ? { var: `input.${part.slice(1, -1)}` } : part)),
      variables: options.variables ?? {},
      query: { fixed: {}, variable: [] },
      max_body_bytes: method === "GET" ? 0 : 65_536,
      max_calls: options.max_calls ?? 1,
      ...(options.max_requests
        ? { pagination: { params: ["page"], max_requests: options.max_requests } }
        : {}),
    },
  } as Effect;
}

function preview(
  effects: Effect[],
  extra: Partial<AuthorityReviewPreview> = {},
): AuthorityReviewPreview {
  return {
    manifest: {
      schema_version: 1,
      tenant_id: "00000000-0000-4000-8000-000000000001",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      workflow_version_id: "00000000-0000-4000-8000-000000000003",
      workflow_digest: "e".repeat(64),
      execution_environment: "prod",
      execution_options_digest: "c".repeat(64),
      effects,
      issues: [],
    },
    approval_carries_over: false,
    schedules: [],
    ...extra,
  };
}

const names = new Map([[connector, "GitHub"]]);
const quiet = { schedule: false, webhook: false };

const readOnly = preview(
  [
    effect("repo", "/repos/acme/app"),
    effect("commits", "/repos/acme/app/commits", { max_calls: 1, max_requests: 30 }),
  ],
  {
    boundary_growth: [],
    effect_changes: [
      {
        step_id: "commits",
        change: "widened",
        effect: "read",
        subject: "commits",
        previous: { effect: "read", max_calls: 1, max_requests: 10 },
      },
      { step_id: "repo", change: "unchanged", effect: "read", subject: "app" },
      { step_id: "milestones", change: "removed", effect: "read", subject: "milestones" },
    ],
    effect_changes_base: {
      workflow_version_id: "00000000-0000-4000-8000-000000000009",
      version: 12,
      approved: true,
    },
  },
);

const writing = preview(
  [
    effect("repo", "/repos/acme/app"),
    effect("comment", "/repos/acme/app/issues/{issue}/comments", {
      method: "POST",
      variables: { "input.issue": { class: "integer" } },
    }),
    effect("purge", "/repos/acme/app/labels/{label}", {
      method: "DELETE",
      effect: "destructive",
      variables: { "input.label": { enum: ["stale"] } },
    }),
  ],
  {
    boundary_growth: [
      { kind: "wider_effect", connector_id: connector, target: null, effect: "write" },
    ],
    effect_changes: [
      { step_id: "purge", change: "unchanged", effect: "destructive", subject: "labels" },
      { step_id: "comment", change: "added", effect: "write", subject: "comments" },
      { step_id: "repo", change: "unchanged", effect: "read", subject: "app" },
    ],
  },
);

test("tiles count reads, writes, services and a separate risky tile", () => {
  expect(
    authorityReviewModel({
      preview: readOnly,
      connectorNames: names,
      automation: quiet,
      activation: true,
      carryOver: false,
    }).tiles,
  ).toEqual({ read: 2, write: 0, services: 1, risky: 0 });
  expect(
    authorityReviewModel({
      preview: writing,
      connectorNames: names,
      automation: quiet,
      activation: true,
      carryOver: false,
    }).tiles,
  ).toEqual({ read: 1, write: 1, services: 1, risky: 1 });
});

test("a read-only review names its scope and service; growth replaces the sentence", () => {
  const read = authorityReviewModel({
    preview: readOnly,
    connectorNames: names,
    automation: quiet,
    activation: true,
    carryOver: false,
  });
  expect(read.sentence).toEqual({ kind: "readOnly", scope: "acme/app", service: "GitHub" });
  const grown = authorityReviewModel({
    preview: writing,
    connectorNames: names,
    automation: quiet,
    activation: true,
    carryOver: false,
  });
  expect(grown.sentence.kind).toBe("growth");
});

test("comparison chips count every change against the named base version", () => {
  const model = authorityReviewModel({
    preview: readOnly,
    connectorNames: names,
    automation: quiet,
    activation: true,
    carryOver: false,
  });
  expect(model.comparison).toEqual({
    version: 12,
    approved: true,
    added: 0,
    widened: 1,
    unchanged: 1,
    removed: 1,
  });
});

test("writes compared only with an unapproved running version still need the write check", () => {
  const unapproved = preview(writing.manifest.effects, {
    effect_changes: writing.effect_changes?.map((entry) => ({
      ...entry,
      change: "unchanged" as const,
    })),
    effect_changes_base: {
      workflow_version_id: "00000000-0000-4000-8000-000000000009",
      version: 10,
      approved: false,
    },
  });
  const model = authorityReviewModel({
    preview: unapproved,
    connectorNames: names,
    automation: quiet,
    activation: true,
    carryOver: false,
  });
  expect(model.requiresWriteCheck).toBe(true);
  expect(model.comparison?.approved).toBe(false);
});

test("rows run from delete to write to new, widened and unchanged; risky rows open", () => {
  const model = authorityReviewModel({
    preview: writing,
    connectorNames: names,
    automation: quiet,
    activation: true,
    carryOver: false,
  });
  const rows = model.groups.flatMap((group) => group.rows);
  expect(rows.map((row) => row.step_id)).toEqual(["purge", "comment", "repo"]);
  expect(rows.map((row) => row.open)).toEqual([true, true, false]);
  const comment = rows[1];
  expect(comment?.change).toBe("added");
  expect(comment?.unbound).toEqual(["issue"]);
  expect(comment?.placeholders).toEqual([{ name: "issue", kind: "class", rule: "integer" }]);
  expect(rows[0]?.placeholders).toEqual([{ name: "label", kind: "enum", values: ["stale"] }]);
  expect(rows[0]?.unbound).toEqual([]);
  const widened = authorityReviewModel({
    preview: readOnly,
    connectorNames: names,
    automation: quiet,
    activation: true,
    carryOver: false,
  }).groups[0]?.rows[0];
  expect(widened).toMatchObject({
    step_id: "commits",
    change: "widened",
    ceiling: 30,
    previousCeiling: 10,
  });
});

test("groups follow the connector and collapse beyond twelve effects", () => {
  const model = authorityReviewModel({
    preview: writing,
    connectorNames: names,
    automation: quiet,
    activation: true,
    carryOver: false,
  });
  expect(model.groups).toHaveLength(1);
  expect(model.groups[0]).toMatchObject({
    name: "GitHub",
    scope: "api.github.com/repos/acme/app",
    counts: { read: 1, write: 1, risky: 1 },
    open: true,
  });
  const many = preview(
    Array.from({ length: 13 }, (_, index) => effect(`read${index}`, `/repos/acme/app/r${index}`)),
  );
  expect(
    authorityReviewModel({
      preview: many,
      connectorNames: names,
      automation: quiet,
      activation: true,
      carryOver: false,
    }).groups[0]?.open,
  ).toBe(false);
});

test("approving a new or widened write needs the write check", () => {
  expect(
    authorityReviewModel({
      preview: writing,
      connectorNames: names,
      automation: quiet,
      activation: true,
      carryOver: false,
    }).requiresWriteCheck,
  ).toBe(true);
  expect(
    authorityReviewModel({
      preview: readOnly,
      connectorNames: names,
      automation: quiet,
      activation: true,
      carryOver: false,
    }).requiresWriteCheck,
  ).toBe(false);
  const steady = preview(writing.manifest.effects, {
    boundary_growth: [],
    effect_changes: writing.effect_changes?.map((entry) => ({
      ...entry,
      change: "unchanged" as const,
    })),
  });
  expect(
    authorityReviewModel({
      preview: steady,
      connectorNames: names,
      automation: quiet,
      activation: true,
      carryOver: false,
    }).requiresWriteCheck,
  ).toBe(false);
  const first = preview(writing.manifest.effects);
  expect(
    authorityReviewModel({
      preview: first,
      connectorNames: names,
      automation: quiet,
      activation: true,
      carryOver: false,
    }).requiresWriteCheck,
  ).toBe(true);
});

test("activate-only moves into the menu when a trigger would stall on a grown boundary", () => {
  const base = { preview: writing, connectorNames: names, carryOver: false } as const;
  expect(authorityReviewModel({ ...base, automation: quiet, activation: true }).buttons).toEqual({
    primary: "approve",
    activateOnly: "footer",
  });
  expect(
    authorityReviewModel({
      ...base,
      automation: { schedule: true, webhook: false },
      activation: true,
    }).buttons,
  ).toEqual({ primary: "approve", activateOnly: "menu" });
  expect(
    authorityReviewModel({
      ...base,
      automation: { schedule: false, webhook: true },
      activation: true,
    }).buttons.activateOnly,
  ).toBe("menu");
  const steady = preview(readOnly.manifest.effects, { boundary_growth: [] });
  expect(
    authorityReviewModel({
      ...base,
      preview: steady,
      automation: { schedule: true, webhook: true },
      activation: true,
    }).buttons.activateOnly,
  ).toBe("footer");
  expect(authorityReviewModel({ ...base, automation: quiet, activation: false }).buttons).toEqual({
    primary: "approve",
    activateOnly: null,
  });
});

test("a carried-over approval offers only adopting it", () => {
  expect(
    authorityReviewModel({
      preview: readOnly,
      connectorNames: names,
      automation: { schedule: true, webhook: true },
      activation: true,
      carryOver: true,
    }).buttons,
  ).toEqual({ primary: "adopt", activateOnly: null });
});

test("the title always uses one template", () => {
  expect(reviewTitle({ name: "GitHub briefing", version: 13 })).toEqual({
    key: "authority.namedTitle",
    values: { name: "GitHub briefing", version: "v13" },
  });
  expect(reviewTitle(null)).toEqual({ key: "authority.grantOpen", values: {} });
});

test("adopting a carried-over approval confirms it stays valid; activate-only says runs wait", () => {
  const base = { preview: writing, connectorNames: names, automation: quiet, activation: true };
  expect(authorityReviewModel({ ...base, carryOver: true }).messages.activated).toBe(
    "authority.adopted",
  );
  expect(authorityReviewModel({ ...base, carryOver: false }).messages.activated).toBe(
    "authority.activatedOnly",
  );
});

test("the activate-only help names a pausing schedule only when a trigger exists", () => {
  const base = { preview: writing, connectorNames: names, activation: true, carryOver: false };
  expect(authorityReviewModel({ ...base, automation: quiet }).messages.activateOnlyHelp).toBe(
    "authority.review.help.activateOnly",
  );
  for (const automation of [
    { schedule: true, webhook: false },
    { schedule: false, webhook: true },
  ])
    expect(authorityReviewModel({ ...base, automation }).messages.activateOnlyHelp).toBe(
      "authority.review.help.activateOnlyPaused",
    );
  expect(translate("de", "authority.review.help.activateOnly")).toBe("Aktiviert ohne Läufe.");
  expect(translate("en", "authority.review.help.activateOnly")).toBe(
    "Activates without allowing runs.",
  );
  expect(translate("de", "authority.review.help.activateOnlyPaused")).toBe(
    "Aktiviert ohne Läufe; Zeitplan pausiert.",
  );
  expect(translate("en", "authority.review.help.activateOnlyPaused")).toBe(
    "Activates without allowing runs; the schedule pauses.",
  );
  expect(translate("de", "authority.adopted")).toBe(
    "Übernommen. Die bestehende Freigabe gilt weiter.",
  );
  expect(translate("en", "authority.adopted")).toBe("Applied. The existing approval stays valid.");
});

test("the subtitle names the running version the review replaces, not the approved baseline", () => {
  expect(replacedVersion({ running: 12, reviewed: 13 })).toBe(12);
  expect(replacedVersion({ running: 13, reviewed: 13 })).toBeNull();
  expect(replacedVersion({ running: null, reviewed: 13 })).toBeNull();
  expect(replacedVersion({ running: 12, reviewed: null })).toBeNull();
});
