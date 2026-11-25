---
slug: reference-files-results-signals
title: Reference: files from the desktop, run results and sign-in signals
summary: Look up the routes, fields, events and audit actions for dropped files, Markdown run results, sign-in signals and full stats series.
section: reference
order: 7
audience: public
---
## Reference: files from the desktop, run results and sign-in signals

This page lists what SubKit added so the desktop app and the Cockpit can show files, results and sign-ins without guessing.
It is for developers and operators who build on these parts. The complete, machine-readable description of every route is at `/openapi.json` on your engine.

### Routes

| Route | Who may call it | Does |
| --- | --- | --- |
| `POST /v1/chat/composer/attachments` | A person with `conversation:write` | Puts a file into your chat composer. It waits there for your next message. |
| `GET /v1/chat/composer/attachments` | A person with `conversation:read` | Lists the files waiting in your composer, newest first. |
| `POST /v1/chat/composer/attachments/claim` | A person with `conversation:write` | Attaches the waiting files to a conversation and empties the composer. |
| `DELETE /v1/chat/composer/attachments/{id}` | A person with `conversation:write` | Takes one file out of your composer. |
| `POST /v1/intake/items/file` | `intake:write` | Collects a file into the inbox. |

“A person” means a user account, not a system account. A system account gets `403 person_required`.

### Files for your next chat message

The desktop app's drop sheet uses these routes for “Attach in chat”. The Cockpit chat picks the files up when it opens or gets focus.

- The body of `POST` is the same as for a conversation attachment: `{filename, content_type, content_base64}` for a new file, or `{"$file": "<file id>"}` for a file that already exists.
- The answer is `{id, file, staged_at, expires_at}`. `file` has the same fields as a conversation attachment, including `slug` and `reference`.
- A file waits for 24 hours. Your composer holds at most 10 files; one more gets `409 composer_full`. Staging the same file again only renews its time.
- Files are limited to 5 MB and go through the same malware check as every upload.
- Only you see, take or remove your own waiting files. Someone else's id answers `404`.
- `claim` takes `{conversation_id, ids?}`. Without `ids` it takes every waiting file. If one of the `ids` is not waiting in your composer, the whole claim is refused with `404` and nothing changes.

### Files in the inbox

`POST /v1/intake/items/file` takes `{client_request_id, captured_at, filename, content_type, content_base64, category?, title?, note?}`.

| Type | `content_type` |
| --- | --- |
| PDF | `application/pdf` |
| Images | `image/png`, `image/jpeg`, `image/gif`, `image/webp` |
| Text | `text/csv`, `text/plain`, `text/markdown`, `application/json` |

- At most 5 MB.
- The bytes must match the type: a PNG must start like a PNG, text must be UTF-8, JSON must parse. HTML, SVG, XML and scripts are refused, also when they claim to be text.
- The file goes through the malware check. A rejected file creates no item.
- `title` defaults to the filename. The item text is the file's whole text for CSV, text, Markdown and JSON; for PDFs and images it is one line naming the file.
- `client_request_id` works as with text items: the same id with the same file returns the same item.
- Every intake item now carries `attachment`: `null`, or `{file_id, filename, content_type, size_bytes}`. Download the file with `GET /v1/files/{file_id}/content` (`file:read`).

| Answer | Code | Meaning |
| --- | --- | --- |
| 413 | `too_large` | Larger than 5 MB. |
| 422 | `unsupported_file_type` | The type is not in the list. |
| 422 | `content_type_mismatch` | The content does not match the type. |
| 422 | `file_rejected` | The malware check rejected the file. |
| 409 | `conflict` | The `client_request_id` was already used for something else. |

### Markdown result of a run

`GET /v1/executions/{id}` now carries `result_markdown` (text or `null`) and `result_markdown_truncated`. The run detail shows the text as the result of the run.

A workflow provides the result in one of two ways:

1. **Declared:** its `output_schema` marks a text as Markdown with `"contentMediaType": "text/markdown"`, either for the whole output or for one top-level field. If several fields carry the mark, the first one counts.
2. **By name:** without such a mark, a top-level text field `result_markdown` in the output counts.

```json
{
  "output_schema": {
    "type": "object",
    "properties": {
      "summary": { "type": "string", "contentMediaType": "text/markdown" }
    }
  }
}
```

- The output counts after `output_transform`, so a transform can build the text from the last step.
- Only a succeeded run keeps a result. It is stored once, when the run ends.
- Secrets are removed before it is stored: tokens, keys and passwords become `***redacted***`, and so do credentials in links. Confidential workflows never keep a result.
- At most 64 KiB of text is kept. A longer text is cut and `result_markdown_truncated` is `true`.

### Links to changed records

`GET /v1/executions/{id}`, the MCP tool `get_execution` and `subkit executions show` carry `record_links`: one entry per record that a request step created or changed in an external system, with `label`, `url`, `connector`, `connector_name` and `step_key`. The Cockpit shows them as buttons such as “View in GitHub” that open in a new tab.

- Built-in connector templates declare which requests lead to a record (`record_url_patterns`) and which web hosts are allowed (`web_hosts`). A web address the response already contains is preferred.
- Only `https` addresses on a known web host count. Connectors without a built-in template get no links.
- Confidential runs, held writes and step outputs that were redacted or stored as a file get no links.
- At most 20 links per run, in step order, each address once.

### Outcome of a scheduled run

Every entry of the schedule history (`GET /v1/workflows/{id}/schedule-occurrences`, `GET /v1/tasks/{id}/schedule-occurrences`) now carries `run_outcome`:

| `run_outcome` | Meaning |
| --- | --- |
| `running` | The run has not ended yet. |
| `succeeded` | The run ended successfully. |
| `failed` | The run failed or ran out of time. |
| `aborted` | The run was stopped. |
| `null` | The entry started no run, or the run is no longer kept. |

`state` keeps describing the timing (on time, late, skipped, held); `run_outcome` says how the run ended.

### Sign-in finished

When a connector sign-in ends, successfully or not, SubKit writes the event `connector.oauth.signin_finished`. This holds for OAuth connectors, MCP connectors and account connections; for an account connection SubKit writes one event per connector that uses it, with `connector_slug` `null`.

| Field | Meaning |
| --- | --- |
| `connector_id` | The connector. |
| `connector_slug` | Its short name, or `null`. |
| `outcome` | `succeeded` or `failed`. |
| `reason` | Why it failed: `provider_error`, `missing_code` or `token_exchange_failed`. `null` on success. |

- On the Cockpit stream (`GET /v1/cockpit/events/stream`, with `connector:read`) the event arrives with `connector_id`, `attention_id`, `outcome` and, on failure, `reason`. The desktop app and the Cockpit wait for it instead of guessing from the window focus.
- Webhook subscriptions can subscribe to it like any other event.
- A sign-in link that expired or is unknown belongs to no connector and writes no event.

### Full stats series

`GET /v1/stats/executions` and `GET /v1/stats/llm` take `fill`:

- `zero` (default): every bucket of the window is listed, oldest first, also the empty ones with `0`. Without `group_by` the answer always has exactly one group.
- `none`: only buckets with data, as before. Useful for wide breakdowns such as `group_by=conversation`.

### Audit actions

| Action | Written when |
| --- | --- |
| `chat.composer_attachment_staged` | A file was put into a composer. |
| `chat.composer_attachment_removed` | A file was taken out of a composer. |
| `chat.composer_attachments_claimed` | Waiting files were attached to a conversation. `file.link_added` follows for each file. |
| `intake_item.collected` | As before; for a file it carries `attachment_file_id`. |
