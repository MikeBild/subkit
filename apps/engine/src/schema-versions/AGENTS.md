# schema-versions — scope and contract

This subsystem tracks the **shape of upstream-API responses** observed during
connector calls. It is the storage layer behind the self-healing drift detector
and behind the per-connector `schemaVersion` field on `ConnectorSystem`.

## What schema versioning IS

- A per-tenant + per-connector + per-endpoint record of the response shape
  ("connector X's `/customers` endpoint last produced this JSON skeleton").
- A signal source for the self-healing drift detector: when the shape changes
  in a way that breaks a workflow, the repair loop opens a patch candidate.
- A pin that tells `ConnectorSystem` consumers which schema version their
  cached structural assumptions were validated against.

## What schema versioning is NOT

- It is **not** a generalized versioning system across every subkit
  subsystem. The following do **not** track `schema_version` and intentionally
  rely on adjacent mechanisms:
  - **Workflows** — the `workflow_versions` table records full draft snapshots;
    `validateWorkflowDef` enforces shape at save time.
  - **Skills** — the `skills` table carries a `version` field on each skill row,
    but it is hand-bumped, not drift-detected.
  - **Knowledge sources** — chunk fingerprints (SHA-256 of canonicalised
    content) detect drift; no `schema_version` column.
  - **Skill candidates** — pattern detectors observe execution traces; no
    schema concept.
- Earlier docs described "schema versioning" as a cross-system strength.
  Pass-3 of the cleanup audit found that misleading: only this subsystem and
  the connector drift detector actually use the `schema_versions` table.

## Future extension path

If a future feature needs to track structural drift inside workflows, skills,
or knowledge, the right move is to extend this subsystem (add a new
`subject_kind` enum value) rather than reinvent a parallel pattern. Keep the
table single-source.
