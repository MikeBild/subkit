---
slug: http-api
summary: Start workflows from your own code and read their results.
section: work
order: 6
audience: public
---
## Use the HTTP API

Your program, script or backend should start an approved workflow and keep working with its result.
This chapter is for developers and takes you from the first key to a run you have read.
Afterwards you know how to start runs, wait for them and handle errors cleanly.

Every example uses `curl`, so you can try it in a terminal first.
SubKit Cloud and a self-hosted engine behave the same here.

### What you need

- Your engine address.
  - Cloud: `https://subkit-cloud.mikebild.info` (without `/cockpit`)
  - Self-hosted: `https://<your-engine>`
- An API key with the scopes `workflow:read`, `workflow:run` and `execution:read`. A scope is a single permission the key carries. Create the key with the sk CLI, as shown below, or in the Cockpit under **API access**. For the CLI, sign in as described in "Use the sk CLI on your machine".
- A workflow that is active and approved. See "Your first workflow".
- `curl` in your terminal.

### Reach the engine

`/health` needs no key.

1. Set the address as a variable:

   ```bash
   export SK_URL=https://<your-engine>
   ```

2. Call `/health`:

   ```bash
   curl -s "$SK_URL/health"
   ```

   ```json
   { "status": "ok", "service": "subkit", "version": "<version>" }
   ```

### Create and check an API key

1. Create a key with exactly the permissions this chapter needs:

   ```bash
   sk apikeys create --name http-api-test --scopes workflow:read,workflow:run,execution:read
   ```

2. Copy `plaintext_key` from the JSON response. It is shown only once, so keep it in a password manager.
3. Put the key in a variable:

   ```bash
   export SK_KEY=<api-key>
   ```

4. Ask the engine who you are:

   ```bash
   curl -s "$SK_URL/v1/identity/whoami" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   The answer names your account, your workspace and the key's scopes (shortened). The workspace is your team's separate area in the engine:

   ```json
   {
     "id": "<user-id>",
     "kind": "user",
     "tenant_slug": "<workspace>",
     "role_name": "admin",
     "scopes": ["workflow:read", "workflow:run", "execution:read"]
   }
   ```

Without `--scopes`, the key gets the same scopes as your own access.
`sk apikeys revoke <key-id>` revokes the key.

### List your workflows

1. Fetch the active workflows:

   ```bash
   curl -s "$SK_URL/v1/workflows?status=active&limit=20" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   Each entry in `items` carries, among others, `id`, `slug`, `name`, `lifecycle` and `operating_status`. In the example the workflow is called "Daily report" (shortened):

   ```json
   {
     "items": [
       {
         "id": "<workflow-id>",
         "slug": "daily-report",
         "name": "Daily report",
         "lifecycle": "active",
         "operating_status": "active"
       }
     ],
     "total": 1,
     "categories": [{ "category": "reporting", "count": 1 }]
   }
   ```

2. Copy the `id`. A run needs the ID; the engine does not accept a slug.

`q=<text>` searches name, slug, description and category.

### Start a run

- Send the workflow ID and its input to `/v1/executions`:

  ```bash
  curl -s -X POST "$SK_URL/v1/executions" \
    -H "Authorization: Bearer $SK_KEY" \
    -H "Content-Type: application/json" \
    -d '{"source":"saved","workflow_id":"<workflow-id>","input":{}}'
  ```

  The call waits for the run and answers `200` with `execution_id`, `status`, `output` and `steps`.

`input` must match the workflow's input. `GET /v1/workflows/<workflow-id>/input-schema` shows what it expects.

### Start a long run in the background

1. Send the run with `"async":true`. Optionally add an `Idempotency-Key` header. With it, a call sent twice by accident still starts only one run:

   ```bash
   curl -s -X POST "$SK_URL/v1/executions" \
     -H "Authorization: Bearer $SK_KEY" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: daily-report-<date>" \
     -d '{"source":"saved","workflow_id":"<workflow-id>","input":{},"async":true}'
   ```

   The engine answers `202` right away:

   ```json
   { "execution_id": "<execution-id>", "status": "queued", "hold_writes": false }
   ```

2. Copy `execution_id` and read the result as described in the next section.

- The `Idempotency-Key` header takes 1 to 200 characters.
- If you send the same key again, no second run starts. The answer carries the first run's ID and `"idempotent_replay": true`.

### Read the result

1. Read the run:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>" \
     -H "Authorization: Bearer $SK_KEY"
   ```

2. Check `status`.
3. On a failure, read `outcome.failed_step` for the step and `error` for the cause.
4. Read each step's output:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>/steps" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   Each entry has `step_key`, `status` and a preview in `output_preview` or `result_preview`. The last step usually holds the workflow's result.

| `status` | Meaning |
| --- | --- |
| `queued`, `running` | The run is still working. |
| `succeeded` | The run is done. |
| `failed`, `timed_out`, `aborted` | The run stopped early. |

`outcome.kind` summarizes the run, for example `succeeded`, `failed` or `held`.
`sk executions result <execution-id>` shows the same result in your terminal.

### Check whether a workflow can run automatically

Before a workflow runs on a schedule, you want to know whether an approval can cover it at all. The field `automation_readiness` holds that answer.

You get it when you save a workflow (`POST /v1/workflows`, `PUT /v1/workflows/{id}`). You also get it when you create or change a schedule (`POST /v1/schedules`, `PUT /v1/schedules/{id}`). The field has the shape `{environment, workflow_version_id, state, issues, repair_guidance}`.

| `state` | Meaning |
| --- | --- |
| `eligible` | A person can approve recurring runs. |
| `repair_required` | No approval can cover the named steps until they change. |
| `verification_unavailable` | The engine could not run the check. Try again later. |

Each `issues` entry names a `step_id` and a `code`. `repair_guidance` says how to change that step. A paused schedule gets no verdict.

### Export and import a package

A package moves your workspace's own resources to another engine. The steps after the import are in "Use the sk CLI on your machine".
Export needs `package:export`, import needs `package:import`.

| Route | Does |
| --- | --- |
| `POST /v1/packages/export` | Creates the package and answers with its `file_id`. |
| `GET /v1/packages/archives/{file_id}` | Downloads the package as a zip file. |
| `POST /v1/packages/import/preview` | Takes the zip as multipart field `archive`, or `{"archive_file_id": "<file-id>"}`. Answers with a plan per item and a `plan_digest`. Changes nothing. |
| `POST /v1/packages/import/apply` | Takes `{"archive_file_id": "<file-id>", "expected_plan_digest": "<plan-digest>"}` and applies the plan. |
| `GET /v1/packages/installs`, `GET /v1/packages/installs/{id}` | Lists past imports. |

If the target changed after the preview, apply answers `409`. Run the preview again.

### Page through lists

Lists return one page at a time. `total` counts all matches.

| List | Page size | Next page |
| --- | --- | --- |
| `GET /v1/workflows` | `limit` (up to 200) | `offset`: skip that many entries |
| `GET /v1/executions` | `limit` (up to 200) | `cursor`: the previous page's `next_cursor` |

Runs come newest first. Pass `next_cursor` back exactly as you received it. When it is `null`, you are on the last page.

```bash
curl -s "$SK_URL/v1/executions?workflow_id=<workflow-id>&status=failed,timed_out&limit=50" \
  -H "Authorization: Bearer $SK_KEY"
```

`status` takes several values, separated by commas.

### How the API is organized

- Every route starts with `/v1`, for example `/v1/workflows`.
- You send your API key in the `Authorization` header as `Bearer <api-key>`. "Bearer" means: whoever presents the key counts as authorized.
- Requests and responses are JSON.
- `/openapi.json` describes every route, field and status code in OpenAPI format.
- `/docs` shows the same description as a searchable reference. Open `https://<your-engine>/docs` in a browser.

### Errors and status codes

Errors are JSON with a machine-readable `code` and a readable `message`:

```json
{
  "code": "not_found",
  "message": "workflow not found",
  "trace_id": "<trace-id>"
}
```

Some errors add `hint` (what to do), `details` (for example the invalid fields) or `retry_after` (seconds).
Branch on `code` in your program, not on `message`. Keep `trace_id` when you report a problem.

| Status | `code` (examples) | Meaning |
| --- | --- | --- |
| `200` | | Done. |
| `202` | | Accepted. The run continues in the background. |
| `400` | `bad_request` | The request is invalid. `details` names the fields. |
| `401` | `unauthorized` | The key is missing, wrong, expired or revoked. Check `Authorization: Bearer <api-key>`, or create a new key. |
| `403` | `forbidden` | The key lacks a scope or your role lacks the permission. Create a key with `workflow:read`, `workflow:run` and `execution:read`. |
| `404` | `not_found` | The ID does not exist in your workspace. |
| `409` | `conflict` | The current state does not allow it. For a run: there is no active version, or the approval is missing or used up. |
| `429` | `rate_limit_exceeded`, `rate_limited` | A limit is reached. Wait as long as the `Retry-After` header says. Then retry with the same `Idempotency-Key`. |
| `500` | `internal_error` | An error in the engine. Report the `trace_id`. |

### If something does not work

| What you see | What to do |
| --- | --- |
| `404 Not Found` as plain text | The path does not exist. Check that it starts with `/v1`. |
| `400` with `request validation failed` | Read `details`. Often `workflow_id` is not a UUID or `input` does not match the input schema. |
| The run answers with `"hold_writes": true` | The version has no approval for this environment. Nothing was written. Approve it as described in "Your first workflow". |
| Any other error status | Look up the status in "Errors and status codes" and read `message` and `details`. |
