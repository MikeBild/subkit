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

`variables` has exactly one entry per placeholder that is a whole path segment or
a whole query value, keyed by the expression without `${}`. An entry normally
lists every value it may take, written exactly as it is sent: `{ "enum": [...] }`,
1 to 50 values of letters, digits, `.`, `_`, `~`, `-`, `:` and `%XX` escapes. Values
are compared byte for byte against the raw segment; an escape that decodes to a
traversal, a control character or a backslash is refused. Percent-encoding does
not let a value span segments: `%2F` is a literal character to the server, so
such a value addresses something else. A path with several varying parts needs
one placeholder per segment. Where the values cannot be listed — an id produced
by an earlier step, a time window — an entry names a value class instead:
`{ "class": "uuid" }`, `integer`, `identifier`, `date`, `timestamp`, `file_name`
(one file name, exactly one dot, never a folder) or `path`. A class approves
every value of that form, the review dialog says so, and a `DELETE` may not use
one.

`path` is the one class that is not a single segment: it stands for the whole
rest of the address, for a step that fetches whichever route an earlier step
listed. It may appear only as the last placeholder in the path — anywhere else
it would swallow the literal segments after it, and the review refuses it with
`path_class_misplaced`. It approves every page on that one address, so prefer
any narrower rule that fits. It cannot reach another address: a value spelling a
scheme or starting `//` is refused, as is one whose escape decodes to a
separator. Placeholders in the body need no entry; the body is limited by
`max_body_bytes` (0 for a request without a body).
`max_calls` is the reviewed number of requests per run. A `DELETE` additionally
needs `destructive: true`, so a removal is never approved by omission.

The review compiles the step against its connector into a fixed origin, a list
of path segments and an exact set of static query parameters, and shows that
target to the approver with each variable by name. At dispatch the materialized
request is matched against the same statement by the same code: origin, method,
every literal segment, every variable segment against its approved values, the
exact query key set (fixed values byte for byte, varying values against their
rule) and the body size. Both sides resolve the URL through the
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
placeholder in `headers`, a query key that varies, a placeholder that is only
part of a path segment or of a query value, a value containing `/` or needing percent-encoding, a placeholder in
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
