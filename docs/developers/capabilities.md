# Capability matrix

> **Reading time:** ~7 min
> **Audience:** Anyone — human or coding agent — checking whether sk can do a specific thing before committing to it

**Every answer here was read out of the code, not out of a feature list.** Where the answer is "partial" the row says what is missing, because a qualified yes that hides its condition is worse than a no. Read [When to use sk — and when not to](../concepts/when-to-use.md) first if the question is still *whether* to use it; this page is for when the question is *can it*.

Answers are `yes` · `partial` · `no`.

---

## Execution

| Question | Answer | What that actually means |
|---|---|---|
| Retry a failed step automatically | partial | Request steps retry, up to `max_retries` (default 4) plus the first attempt. Transform, branch, loop, parallel and wait steps do not retry at all. Within request steps it is not uniform either: the HTTP and GraphQL paths retry, the object-storage and database paths do not and always report zero retries. |
| Backoff between retries | yes | Exponential from a per-step base, doubling, capped at 30 seconds, with jitter. A `Retry-After` header on a 429 is honoured. |
| Time-box a run | yes | A workflow-level timeout aborts the whole run and records it as timed out. |
| Time-box a single step | partial | Three step kinds honour `timeout_ms`: transform, request and wait-for-event. Branch, loop, parallel and call do not. On a request step the value bounds one attempt, so N retries can each use the full budget. |
| Bound how many runs happen at once | yes | `queue.concurrency` sets how many executions one replica runs at once, and takes effect on restart. It defaults to 1, which is what the engine did before the setting was wired up, so raising it is a deliberate act rather than something an upgrade does to you. |
| Schedule a workflow | yes | Five-field cron, plus an `every:<seconds>` form for sub-minute work. Cron resolution is one minute. |
| Wait for hours or days | partial | A plain wait is capped at 24 hours. Longer pauses use a wait-for-event step, allowed out to 30 days. Both hold the replica's single execution slot for the whole duration, so a multi-day wait blocks other runs on that replica. |
| Survive an engine crash mid-run | no | A crashed run does not continue. On restart the engine sweeps runs left in flight, terminalizes them and audits the recovery; a wait that died with the process is recorded as abandoned. There is no checkpointed resume, and a re-run would start from the first step and repeat side effects already performed. Design for it: make the trigger repeatable rather than assuming the run picks itself up. |
| Prevent the same trigger running twice | partial | Inbound webhooks are deduplicated against a replay table, and chat events against their platform event id. The generic API and CLI trigger paths accept no idempotency key: two identical calls produce two runs. |

## Governance

| Question | Answer | What that actually means |
|---|---|---|
| Pause for a human decision | partial | There is no approval step kind. In-workflow pauses use a wait-for-event step released by a signal, which can be a one-shot signed approval link, and the wait is bracketed by audit entries. Separately, invoking a workflow from a chat or agent surface can be gated by a tool approval that binds and encrypts the arguments. What the engine does not do is bind the release to a specific person: it binds the token to the tenant, the run and the event. |
| Audit what happened | partial | Every lifecycle change writes an audit entry through an append-only writer with no update or delete path, and entries survive tenant deletion. The immutability is a code convention: no database constraint, trigger or row-level security prevents an operator with database access from editing the table. |
| Encrypt credentials at rest | yes | AES-256-GCM with a random per-record nonce and an authentication tag, bound to the record it belongs to. |
| Separate credentials per tenant | yes | Every credential carries its tenant and is removed with it. |
| Give each end user their own credential for a shared connector | no | Not offered. A table and a write endpoint existed while nothing on the execution path ever read a row back, so an attached credential silently never applied; the endpoint was removed rather than left accepting data the engine cannot honour. |
| Isolate tenants | partial | Every tenant-owned table carries a tenant column and every query is expected to filter on it, enforced by a build-time analyser that fails the build on an unfiltered query. There is no row-level security in the database, so the isolation is as strong as that gate, not as strong as Postgres. |
| Rotate the master key | no | One key for the whole deployment, read from the environment at boot. Rotating it makes every stored secret unreadable. Back it up before you need it. |

## Code and integration

| Question | Answer | What that actually means |
|---|---|---|
| Run custom logic in a step | yes, deliberately narrow | A transform step runs JavaScript in a WebAssembly sandbox with a frozen standard library, a wall-clock deadline, an instruction budget and a 128 MB heap. |
| Reach the network, disk or the process from that code | no | Not restricted by policy but absent by construction: no host function of any kind is exposed to the sandbox. No fetch, no filesystem, no process, no timers, no host clock, no host randomness. Work that needs those belongs in your own service behind a request step. |
| Trigger a run from outside | yes | Verified inbound webhooks create and enqueue a run. Also the HTTP API, the CLI, MCP and chat surfaces. |
| Notify other systems on events | yes | Outbound subscriptions match event patterns and deliver HMAC-signed payloads, with a retry ladder from one minute out to three days, dual-secret rotation and a per-subscription circuit breaker. |

## Operating it

| Question | Answer | What that actually means |
|---|---|---|
| Run it on a laptop | yes | One command from a checkout, or the Compose file any engine serves at `/docker-compose.yml`. |
| Run it without an AI provider | yes, with one limit | Set the provider to `mock` and the engine runs end to end. Conversational authoring is inert in that mode, so build workflows as JSON instead. |
| Run it without object storage | no | Mandatory, and not only for file features: any step result over 10 KB is offloaded there, so ordinary API responses fail without a bucket. |
| Run it without a separate queue or cache service | yes | The queue lives in the same PostgreSQL. No Redis, no broker. |
| Get everything back out | yes | Workflows, runs, steps and the audit log are all JSON over a documented OpenAPI surface and from the CLI, with a dedicated audit export. The definition you export is the definition you can post back. One caveat: step payloads over 10 KB live in object storage and the API returns a reference plus a short preview, so a complete export of large results needs bucket access too. |
| Read the documentation without reaching the source repository | yes | The engine serves the whole documentation set out of its own binary. The repository is private and nothing below needs it. |

---

## Everything the binary hands you

The source repository is private, and nothing here depends on it. Every artefact an outsider needs is embedded in the engine binary and served over the URL the engine already has — the same address you send API calls to.

| From a running engine | What you get |
|---|---|
| `GET /docker-compose.yml` | The topology that runs this exact release |
| `GET /install` | The installer for the matching `sk` binary |
| `GET /llms.txt` | An index of every documentation page |
| `GET /llms/<path>` | One page, for example `concepts/when-to-use.md` |
| `GET /llms-full.txt` | The whole documentation set in one fetch |
| `GET /openapi.json` | The full API surface |
| `GET /.well-known/service-descriptor.json` | The above, listed with checksums |

---

## What this page will not tell you

Whether sk is the right choice. That is a different question with a different page: [When to use sk — and when not to](../concepts/when-to-use.md). A capability matrix answers "can it", and a tool can be perfectly capable of something you should not use it for.
