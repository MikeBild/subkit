---
slug: workflow-authoring-loop-examples
scope: global
title: Workflow Loop Worked Examples
description: Two complete worked examples: listing DigitalOcean projects with their resources through a loop, and HATEOAS link expansion that follows `links.self`.
activates_when: [{"kind":"intent_keyword","word":"hateoas"},{"kind":"intent_keyword","word":"links.self"},{"kind":"intent_keyword","word":"worked example"},{"kind":"intent_keyword","word":"loop example"},{"kind":"intent_keyword","word":"digitalocean"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, orchestration, example]
version: 1
---

# Workflow Loop Worked Examples

### Worked example: list DigitalOcean projects + their resources

This is the canonical pattern when a user asks for "list every X with its
resources / children / details" AND no bulk endpoint covers it. (Check
for a bulk list endpoint first — see the design rule above.)

```json
[
  {
    "id": "fetch_projects",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects"
  },
  {
    "id": "extract_projects",
    "kind": "transform",
    "language": "javascript",
    "expression": "return input.scope.fetch_projects.data.projects.map(p => ({ id: p.id, name: p.name }));"
  },
  {
    "id": "fetch_resources",
    "kind": "loop",
    "over": "$scope.extract_projects.data",
    "body": ["get_project_resources"]
  },
  {
    "id": "get_project_resources",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects/${item.id}/resources"
  },
  {
    "id": "format_output",
    "kind": "transform",
    "language": "javascript",
    "expression": "return input.scope.fetch_resources.data.map(iter => ({ project: iter.get_project_resources.data ? iter.get_project_resources.data.project_name : null, resources: iter.get_project_resources.data.resources }));"
  }
]
```

Four rules this example encodes:
1. Loop body uses `${item.id}` in HTTP placeholders (NOT `${project.id}`). The placeholder resolver only accepts `cred|connector|input|scope|item`; `${project.id}` becomes `placeholder_unresolved`.
2. **EVERY step output is uniformly enveloped** as `{data, status_code?, headers?, duration_ms, error}` — including `transform` and `loop`. The loop's `over` reads `$scope.extract_projects.data` (the array), not `$scope.extract_projects` (the envelope). See `data-handling.md`.
3. Loop output is at `$scope.<loop_id>.data.<body_step_id>.data` (envelope-in-envelope) — in JS: `input.scope.<loop_id>.data[i].<body_step_id>.data`.
4. `${item.…}` for path/url/headers/query/body strings; `$item` for JSONata expressions. Mixing surfaces as `placeholder_unresolved` or `unresolved_identifier`.

### Worked example: HATEOAS link expansion (follow `links.self`)

When a list endpoint returns resources with a `links.self` URL pointing
at the full record (DigitalOcean, GitHub, Stripe, JSON:API services),
the natural author shape is **two flat loops** — one to fetch the IDs,
a second one to flatten and re-fetch each `links.self`. Do NOT try to
nest loops; the body of a `loop` step is an array of step ids, not
another loop.

```json
[
  {
    "id": "fetch_projects",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects"
  },
  {
    "id": "fetch_resources",
    "kind": "loop",
    "over": "$scope.fetch_projects.data.projects",
    "body": ["get_project_resources"]
  },
  {
    "id": "get_project_resources",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects/${item.id}/resources"
  },
  {
    "id": "flatten_links",
    "kind": "transform",
    "language": "javascript",
    "expression": "const HOST = 'https://api.digitalocean.com'; const out = []; for (const iter of input.scope.fetch_resources.data) { for (const r of iter.get_project_resources.data.resources) { out.push({ urn: r.urn, path: r.links.self.slice(HOST.length) }); } } return out;"
  },
  {
    "id": "expand_resource",
    "kind": "loop",
    "over": "$scope.flatten_links.data",
    "body": ["fetch_resource_detail"]
  },
  {
    "id": "fetch_resource_detail",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "${item.path}"
  },
  {
    "id": "merge_full_details",
    "kind": "transform",
    "language": "javascript",
    "expression": "return input.scope.expand_resource.data.map(iter => ({ detail: iter.fetch_resource_detail.data }));"
  }
]
```

Three rules this encodes:
1. **Strip the connector base URL before reusing `links.self`.** The
   connector's `base_url` already includes the path prefix (e.g.
   `/v2`). If you write `${item.url}` against a connector with
   `base_url: https://api.digitalocean.com/v2`, the URL resolver pastes
   the full self URL on top and you double the host. Use `${item.path}`
   where `path` was extracted by stripping the host in the previous
   transform.
2. **Flatten before the second loop.** A loop body cannot recursively
   loop; the body field is an array of step ids. Project the parent
   loop output into a flat array of `{ ...parent_keys, path }` objects
   before the second loop runs.
3. **Use `${item.path}` not `${item.links.self}`.** The path is what
   the connector expects relative to its base_url. The full self URL
   (host included) is rejected with `404` because the host is fixed by
   the connector definition.

Alternative — **`expand_links` directive** (when the API consistently
uses `links.self` and you want to skip the manual flatten):

```json
{
  "id": "fetch_resources_expanded",
  "kind": "request",
  "method": "GET",
  "connector_id": "<digitalocean_connector_id>",
  "path": "/v2/projects/${item.id}/resources",
  "expand_links": ["links.self"]
}
```

The HTTP driver follows every `links.self` URL in the response (capped
at 50 per request) and embeds each fetched body under `_resolved` next
to the original entry. Use the manual two-loop pattern when you need
control (rate limits, conditional expansion); use `expand_links` when
the shape is consistent.
