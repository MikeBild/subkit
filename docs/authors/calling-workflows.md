# Calling a Workflow

A saved workflow is something other systems can start: your app, a service that sends
webhooks, an AI client, a schedule, or a terminal. This page shows each way, what to send,
and what comes back.

> **Reading time:** ~6 min · **Audience:** anyone who built a workflow and now wants to use it

The quickest route is the workflow's own page in the Cockpit. Its **Call** section shows
the exact address, a ready-to-paste snippet, the webhook address and how it is signed, the
tool name, the schedule and the command — for that workflow, with its real input. Everything
below explains what you see there.

The same facts are available to scripts in one read:

```bash
curl -sS "$SK_ENGINE_URL/v1/workflows/<workflow-id>/invocation" \
  -H "authorization: Bearer $SK_API_KEY"
```

It never returns a key or a webhook signing secret — header names only.

Two parts of that answer need reading with care:

- `authority` says, per environment, whether an approval for the running version
  **exists**. It is not a promise that the next call runs with effect: the run itself
  also checks that the approval still covers what the workflow does today, and holds
  or refuses the call if it does not. The run's answer is the one that counts.
- `hooks` and `schedules` are listed only for a caller who may read them.
  `visibility` says which; a list that is missing was withheld, not empty.

## Before you call: is it approved?

A workflow that writes to other systems runs with effect only inside an approval a person
gave: which version, in which environment, until when, how many runs.

| The workflow page says | What a call does |
|---|---|
| **Approved** | Runs with effect, and counts against the approved runs |
| **Approval needed**, **Change waiting** or **Repair needed** | Runs as a **trial run**: reads happen, writes are held back |
| **On request** (nothing starts it automatically, nothing approved) | Runs as a trial run until someone approves it |

A trial run is safe to repeat. It is also why a call can "succeed" and nothing arrives: look
at the state first. The response tells you which kind of run it was (`hold_writes`).

## From your app (HTTP)

One request starts a run:

```bash
curl -sS -X POST "$SK_ENGINE_URL/v1/executions" \
  -H "authorization: Bearer $SK_API_KEY" \
  -H "x-subkit-environment: prod" \
  -H "content-type: application/json" \
  -d '{"source":"saved","workflow_id":"<workflow-id>","input":{"recipient_email":"ops@example.org"}}'
```

Three things to get right:

- **Input goes in the body, under `input`.** There are no query parameters. The workflow
  page lists every field with its type, whether it is required, and an example.
- **Say where it runs.** `x-subkit-environment` is `prod` or `dev`. Leave it out and the
  call runs in development — against the development connectors, not the production ones.
- **The key comes from your environment.** Create one on the Cockpit's credentials page,
  under keys for scripts, and keep it out of source control.

| Answer | Meaning |
|---|---|
| `200` | The run finished; the body carries the result |
| `202` | The run was queued (`"async": true`); follow it with `GET /v1/executions/{id}` |
| `409` | The run was refused before it started — the body says why, for example a connector that must be reconnected |

To make a call safe to repeat, add `"idempotency_key"`: a second call with the same key
returns the first run instead of starting another.

`sk workflows invoke-snippet <workflow-id>` prints the same request the workflow page
shows — the engine's own snippet, with the workflow's sample input and the engine's
public address — for curl, Node or Python (`--lang`), for production or development
(`--environment`). If the engine cannot be reached, does not know the workflow, or has
no public address configured, the command prints a snippet with your profile's engine
address and an empty input instead, and says so.

## From another service (webhook)

When a workflow has an inbound hook, the other service posts to:

```
POST <your engine address>/v1/hooks/<hook-name>
```

There is no API key on this address — the **signature is the authentication**. The workflow
page names the scheme and the exact headers a delivery must carry, for example
`webhook-id`, `webhook-timestamp` and `webhook-signature` for the standard scheme, or the
sender's own header names for a custom HMAC scheme.

The workflow does not receive the sender's body as its input directly. It receives an
envelope, and the body is one field of it:

```json
{
  "id": "msg_2YcX",
  "type": "finding.created",
  "timestamp": 1790000000,
  "headers": { "content-type": "application/json" },
  "body": { "finding": { "id": "F-17", "severity": "high" } }
}
```

So a step reads the sender's data at `input.body`, not at `input`.

Webhook deliveries always run in production, and they need an approval like any other
automatic run. Until there is one, deliveries are refused and the workflow page shows the
hook as waiting.

## From an AI client (MCP)

A saved workflow can appear in a client's tool list as `wf_<workflow-name>`, with the
workflow's input as its arguments. Not every workflow appears for every client: the list
depends on what the caller may do and holds a bounded number of workflow tools. The
`run_workflow` tool runs any saved workflow the caller may run, listed or not:

```json
{ "workflow": "<workflow-name>", "input": { "recipient_email": "ops@example.org" } }
```

## On a schedule

A schedule starts the workflow by itself, at the times and in the timezone it names, with a
fixed input. The workflow page shows the schedule in words, the environment it runs in, its
fixed input and the next run. A schedule needs an approval; without one it is held, and the
page says so instead of running.

## From a terminal

```bash
sk workflows run <workflow-name> --input '{"recipient_email":"ops@example.org"}'
```

`--input @./payload.json` reads the input from a file. This command sends no environment,
so it runs in development.

## Where to look when a call does nothing

1. **The state on the workflow page.** No approval means a trial run.
2. **The latest runs** on the same page: each run says how it ended and, if it stopped,
   at which step and why.
3. **The environment.** A call without `x-subkit-environment` ran in development.

See also: [Scheduling and hooks](../operators/scheduling-and-hooks.md) for how schedules
and hooks are bound and approved, and
[Input surfaces](../developers/input-surfaces.md) for every way into the engine.
