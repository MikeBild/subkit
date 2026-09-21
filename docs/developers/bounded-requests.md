# Bounded requests

A scheduled workflow runs without a person present, so a person approves its
effects once, for a finite number of runs. That only works for a request whose
target a reviewer can read. A request step whose path or body is filled in at run
time is reported as `dynamic_request` and blocks repeated runs — unless the
author declares a boundary on the step and a human approves it.

```json
{
  "id": "retire_expired",
  "kind": "request",
  "connector_id": "<connector id>",
  "method": "POST",
  "path": "/v1/sites/${input.site}/releases",
  "body": { "retire_item_ids": "${scope.select_expired.data.ids}" },
  "boundary": {
    "variables": { "input.site": { "enum": ["reports"] } },
    "max_body_bytes": 20000,
    "max_calls": 1
  }
}
```

`variables` has exactly one entry per placeholder in the path, keyed by the
expression without `${}`, listing every value it may take: 1 to 50 values of
letters, digits, `.`, `_`, `~` and `-`. Placeholders in the body need no entry;
the body is limited by `max_body_bytes` (0 for a request without a body).
`max_calls` is the reviewed number of requests per run. A `DELETE` additionally
needs `destructive: true`, so a removal is never approved by omission.

The review compiles the step against its connector into a fixed origin, a list
of path segments and an exact set of static query parameters, and shows that
target to the approver with each variable by name. At dispatch the materialized
request is matched against the same statement by the same code: origin, method,
every literal segment, every variable segment against its approved values, the
exact query key set and the body size. Both sides resolve the URL through the
HTTP driver's own resolver, so a connector base URL that carries a path is part
of the reviewed target. A request that differs is refused before any network
call: the step fails with `authority_invalid` and the run ends as failed.

A step is held to the boundary it declares on every run, not only under an
approval. A preview materializes the request and compares it before anything is
held or sent; a request that does not fit fails the step with
`request_outside_declared_boundary` and names the actual and the allowed size or
the reviewed target. A green preview therefore means the request fits what the
human is about to be asked to approve. Size `max_body_bytes` from the workflow's
own limits, such as a batch cap times the bytes per item, not from one preview.

A boundary limits where a request goes and how large it is. It does not limit
what the body says — which records a release retires, what a page contains. The
review dialog says so, and an author should say so to the approver. `max_calls`
is reviewed but not yet counted by the engine.

Not covered, and refused with a named reason rather than silently ignored: a
placeholder in `query` or `headers`, a placeholder that is only part of a path
segment, a value containing `/` or needing percent-encoding, a placeholder in
the part of the path that overlaps the connector's base path, `pagination`, a
connector that adds its own query parameters, and any step a stricter profile
already describes (report e-mail, [content publication](bounded-content-publication.md)).
Storage steps use the storage boundary `s3.scope` instead; it is held to on every
run in the same way, by folder and by written size.

Regression coverage lives in `request-boundary.test.ts` (compile, refusals,
denial table including encoded traversal), `effect-manifest.test.ts`
(eligibility, tampered bindings, removals), `effect-digest-pin.test.ts`
(existing approvals keep their digest), `authority-runtime.integration.test.ts`
(an unapproved value or an oversize body never reaches the remote) and
`hold-writes.test.ts` (preview and live run refuse the same request alike).
