---
slug: http-api
summary: Call SubKit from your own program or script over HTTP.
section: work
order: 6
audience: public
---
## Use the HTTP API

In this chapter you call SubKit from your own program or script.
You create an API key, check it, list your workflows, start a run and read its result.
Every example uses `curl`, so you can try it in a terminal first.

It works the same in SubKit Cloud and on a self-hosted engine.

### What you need

- The address of your engine.
  - Cloud: `https://subkit-cloud.mikebild.info`
  - Self-hosted: `https://<your-engine>`
- The sk CLI, signed in to that engine. See the chapter **Use the sk CLI on your machine**.
- A workflow that is active and approved. See the chapter **Your first workflow**.
- `curl` in your terminal.

### How the API is organized

- Every API route starts with `/v1`, for example `/v1/workflows`.
- You send your API key in the `Authorization` header as a bearer token.
- Requests and responses use JSON.
- `/openapi.json` describes every route, field and status code (OpenAPI 3.1).
- `/docs` shows the same description as a browsable reference.

Open `https://<your-engine>/docs` in your browser to look up any route from this chapter.

### Step 1: Reach the engine

`/health` needs no key. Use it to check the address.

```bash
export SK_URL=https://<your-engine>
curl -s "$SK_URL/health"
```

```json
{ "status": "ok", "service": "subkit", "version": "<version>" }
```

### Step 2: Create an API key

1. Create a key with the sk CLI. Give it a name and only the permissions this chapter needs:

   ```bash
   sk apikeys create --name http-api-test --scopes workflow:read,workflow:run,execution:read
   ```

2. The answer is JSON. Copy the value of `plaintext_key`.
   The key is shown only once. Store it in a password manager or a secret store.
3. Put the key into a variable for the next steps:

   ```bash
   export SK_KEY=<api-key>
   ```

Without `--scopes`, the key gets the same scopes as your own credential.
`sk apikeys revoke <key-id>` revokes the key when you no longer need it.

### Step 3: Check the key

Ask the engine who you are:

```bash
curl -s "$SK_URL/v1/identity/whoami" \
  -H "Authorization: Bearer $SK_KEY"
```

The answer names your account, your workspace and the scopes of the key (abridged):

```json
{
  "id": "<user-id>",
  "kind": "user",
  "tenant_slug": "<workspace>",
  "role_name": "admin",
  "scopes": ["workflow:read", "workflow:run", "execution:read"]
}
```

If you get `401`, the key is wrong or revoked. See **If something does not work**.

### Step 4: List your workflows

```bash
curl -s "$SK_URL/v1/workflows?status=active&limit=20" \
  -H "Authorization: Bearer $SK_KEY"
```

The answer has `items`, `total` and `categories`. Each item carries, among others,
`id`, `slug`, `name`, `lifecycle` and `operating_status` (abridged):

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

Copy the `id`. Runs need this id; a slug is not accepted.
`q=<text>` searches name, slug, description and category.

### Step 5: Start a run

Send the workflow id and its input to `/v1/executions`:

```bash
curl -s -X POST "$SK_URL/v1/executions" \
  -H "Authorization: Bearer $SK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"saved","workflow_id":"<workflow-id>","input":{}}'
```

- `input` must match the input of the workflow. `GET /v1/workflows/<workflow-id>/input-schema` shows what it expects.
- Without `async`, the call waits until the run has finished. It answers `200` with
  `execution_id`, `status`, `output` and `steps`.

For longer runs, start them in the background:

```bash
curl -s -X POST "$SK_URL/v1/executions" \
  -H "Authorization: Bearer $SK_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: daily-report-2026-10-21" \
  -d '{"source":"saved","workflow_id":"<workflow-id>","input":{},"async":true}'
```

```json
{ "execution_id": "<execution-id>", "status": "queued", "hold_writes": false }
```

The answer is `202`. The `Idempotency-Key` header is optional (1 to 200 characters).
If you send the same key again, no second run starts. The answer carries the first run's id and `"idempotent_replay": true`.

### Step 6: Check the result

1. Read the run:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>" \
     -H "Authorization: Bearer $SK_KEY"
   ```

2. Look at `status`. `queued` and `running` mean the run is not finished yet; ask again a little later.
   `succeeded` means the run finished. `failed`, `timed_out` and `aborted` mean it stopped.
3. `outcome.kind` sums the run up, for example `succeeded`, `failed` or `held`.
   For a failed run, `outcome.failed_step` names the step and `error` holds the cause.
4. Read the output of each step:

   ```bash
   curl -s "$SK_URL/v1/executions/<execution-id>/steps" \
     -H "Authorization: Bearer $SK_KEY"
   ```

   Each item has `step_key`, `status` and a preview of its output in `output_preview` or `result_preview`.
   The last step usually holds the result of the workflow.

`sk executions result <execution-id>` shows the same result in your terminal.

### Pagination

Lists return one page at a time. `total` counts all matches.

| List | Page size | Next page |
| --- | --- | --- |
| `GET /v1/workflows` | `limit` (up to 200) | `offset`: skip that many entries |
| `GET /v1/executions` | `limit` (up to 200) | `cursor`: the `next_cursor` of the previous page |

Runs are listed newest first. Pass `next_cursor` back exactly as you got it.
When `next_cursor` is `null`, you have reached the last page.

```bash
curl -s "$SK_URL/v1/executions?workflow_id=<workflow-id>&status=failed,timed_out&limit=50" \
  -H "Authorization: Bearer $SK_KEY"
```

`status` accepts several values separated by commas.

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
| `400` | `bad_request` | The request is invalid. `details` lists the fields. |
| `401` | `unauthorized` | The key is missing, wrong, expired or revoked. |
| `403` | `forbidden` | The key or your role may not do this. |
| `404` | `not_found` | The id does not exist in your workspace. |
| `409` | `conflict` | The current state does not allow it, for example no approved version. |
| `429` | `rate_limit_exceeded`, `rate_limited` | A limit is reached. Wait as long as the `Retry-After` header says, if it is set. |
| `500` | `internal_error` | An error in the engine. Report the `trace_id`. |

### If something does not work

| What you see | What to do |
| --- | --- |
| `404 Not Found` as plain text | The path does not exist. Check that it starts with `/v1`. |
| `401` with `unauthorized` | Check the `Authorization: Bearer <api-key>` header. Create a new key if it was revoked. |
| `403` with `forbidden` | The key lacks a scope, or your role lacks the permission. Create a key with the scopes from step 2. |
| `400` with `request validation failed` | Read `details`. Often `workflow_id` is not a UUID or `source` is missing. |
| The run answers `"hold_writes": true` | The version has no approval for this environment. Nothing was written. Approve it as in **Your first workflow**, step 4. |
| `409` when you start a run | Read `message` and `details`. The workflow has no active version, or its approval is missing or used up. |
| `429` | Wait as long as `Retry-After` says, or until the limit resets, then try again with the same `Idempotency-Key`. |

### Next

You can now start and check workflows from any program. Continue with the chapter
**Onboard an app** to let the users of your own app call SubKit with their sign-in.
