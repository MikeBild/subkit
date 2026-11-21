import { expect, test } from "bun:test";
import {
  type AuditDetailAdapter,
  auditDetailFacts,
  auditEvidenceBlocks,
  auditMetadataFacts,
  type MetadataAdapter,
} from "@/features/audit/model/audit-evidence";
import { translate } from "@/lib/i18n";

const t = (key: Parameters<typeof translate>[1]) => translate("en", key);

test("audit evidence preserves every defined before/after value in recorded order", () => {
  expect(auditEvidenceBlocks({ before: null, after: undefined })).toEqual([]);
  expect(auditEvidenceBlocks({ before: false, after: 0 })).toEqual([
    { kind: "before", text: "false" },
    { kind: "after", text: "0" },
  ]);
  expect(auditEvidenceBlocks({ before: "", after: { changed: ["name"] } })).toEqual([
    { kind: "before", text: '""' },
    { kind: "after", text: '{\n  "changed": [\n    "name"\n  ]\n}' },
  ]);
  expect(auditEvidenceBlocks({ before: { toJSON: () => undefined } })).toEqual([
    { kind: "before", text: "[object Object]" },
  ]);
});

test("audit metadata extracts only registered scalar facts and retains all other records", () => {
  const adapter: MetadataAdapter = {
    references: {
      resource: {
        label: "audit.timeline.resource",
        open: "audit.timeline.openResource",
        href: (id) => `/resources/${id}`,
      },
    },
    values: { count: "audit.count" },
  };
  expect(auditMetadataFacts(null, t, adapter)).toEqual({ facts: [], rest: null });
  expect(auditMetadataFacts(undefined, t, adapter)).toEqual({ facts: [], rest: null });
  expect(
    auditMetadataFacts(
      {
        resource: " r-1 ",
        count: 2,
        blank: "  ",
        bool: true,
        nan: Number.NaN,
        list: ["kept"],
      },
      t,
      adapter,
    ),
  ).toEqual({
    facts: [
      {
        key: "resource",
        label: "Resource",
        value: "Open resource · r-1",
        href: "/resources/r-1",
      },
      { key: "count", label: "{count} entries", value: "2", href: null },
    ],
    rest: '{\n  "blank": "  ",\n  "bool": true,\n  "nan": null,\n  "list": [\n    "kept"\n  ]\n}',
  });
  expect(
    auditMetadataFacts({ resource: "  ", count: Number.POSITIVE_INFINITY }, t, adapter),
  ).toEqual({
    facts: [],
    rest: '{\n  "resource": "  ",\n  "count": null\n}',
  });
});

test("audit detail facts keep the full recorded shape and object-name fallbacks", () => {
  const entry = {
    ts: "2026-11-09T00:00:00.000Z",
    actor_id: " actor ",
    resource_id: "  ",
    trace_id: " trace ",
    ip: null,
    user_agent: " agent ",
    id: " record ",
    resource_type: "workflow",
    resource_name: " named ",
  };
  const labels: AuditDetailAdapter<typeof entry> = {
    result: () => ({ text: "Succeeded", machine: false }),
    actor: () => null,
    resource: () => ({ text: "workflow", machine: true }),
    reason: () => null,
  };
  expect(auditDetailFacts(entry, t, (value) => `at:${String(value)}`, labels)).toEqual([
    { label: "When", value: "at:2026-11-09T00:00:00.000Z" },
    { label: "Result", value: "Succeeded" },
    { label: "Who", value: null },
    { label: "Actor ID", value: "actor", mono: true },
    { label: "Kind", value: "workflow", mono: true },
    { label: "Resource ID", value: null, mono: true },
    { label: "Reason", value: null },
    {
      label: "Operation",
      value: "trace",
      mono: true,
      prominent: true,
      help: "This identifier connects the entries belonging to the same operation.",
    },
    { label: "IP address", value: null, mono: true },
    { label: "Client program", value: "agent", mono: true },
    { label: "Record ID", value: "record", mono: true },
  ]);
});
