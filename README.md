# sk

**Your AI experiments become something IT will sign off on.**

Teams are already wiring assistants into real systems. sk turns that from a pilot nobody
will approve into an operation that runs: you describe what should happen, you review what
sk builds, you approve it once — and from then on every run is permission-checked,
recorded, and replayable.

[![ci](https://github.com/mikebild/subkit/actions/workflows/ci.yml/badge.svg)](https://github.com/mikebild/subkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**New to this?** [Start here](docs/start-here.md) — no prior knowledge assumed, no code on
the page.

![Describing a workflow in plain language, previewing it, approving it, and running it in the sk terminal](docs/_tapes/out/repl-author.gif)

---

## What you get

Not a toolkit you then have to build something with — three results you can sign off on.

| | You can sign this off when | Typical |
|---|---|---|
| **Your most expensive manual routines run by themselves.** The Monday revenue mail, the invoice check, the new-joiner setup — one process each, live, on a schedule or on an event | you watch one real run end to end and the result is right | 2–4 weeks |
| **Your AI pilot becomes reviewable.** Three hand-wired integrations become one operation: permissions set, writes behind an approval, every run accounted for | your auditor reads one report and has no follow-up question | 1–2 weeks |
| **A system is connected — and stays connected.** When the vendor changes their API, you get a repair suggestion instead of a support ticket | you change the target API and the suggestion arrives | ~1 week per system |

## What sk does not do

It does not migrate legacy data — moving bulk records with field-level reconciliation is a
different job and needs different tooling.

And it does not improvise. If nobody described it and nobody approved it, it does not run.

---

## Start where you are

| You want to | Go to |
|---|---|
| Understand what this is, from scratch | [Start here](docs/start-here.md) |
| Get an engine running and build your first workflow | [Self-host quickstart](docs/developers/self-host.md) |
| Ground a coding agent (Claude Code, Codex, Cursor, …) in your team's knowledge | [Use sk from a coding agent](docs/authors/coding-agents.md) |
| Run sk for a team | [Operator quickstart](docs/operators/quickstart.md) |
| Build workflows by conversation | [Author quickstart](docs/authors/quickstart.md) |
| Work out which door fits which job | [Choosing your surface](docs/authors/choosing-your-surface.md) |
| Contribute to sk | [Developer quickstart](docs/developers/quickstart.md) |

---

## Why this holds up in production

The promise above only survives contact with production because of what sits underneath
it. That part is deliberately boring.

![sk architecture at a glance — external AI clients cross the product-local MCP OAuth boundary into the engine; other surfaces enter directly. Tenant Context (Skills · Knowledge · Discovery · Skill/Patch Candidates) is the compounding learning loop.](docs/concepts/overview.png)

**AI builds; it does not decide at runtime.** An assistant helps you author the workflow.
Once you approve it, its control flow is fixed — the engine follows the approved definition
and does not re-decide anything on the next run.

**One gate, whatever the door.** CLI, chat, MCP client, REST call, webhook, schedule: every
entry point lands in the same pipeline, and one policy decision governs every write.
Dispatching a write from a conversation needs a confirmation, rendered per surface.

**Nothing reaches production unreviewed.** A workflow gets there through an explicit
approval, or through a dry run whose preview is returned before anything is committed. On
an unattended turn, where no confirmation can be delivered, a clean dry run commits on its
own — and the audit row records that it did, so the review happens after the fact rather
than not at all. Starting an unattended trigger is always a separate decision on top.

**Secrets stay out of the loop.** Credentials live in an encrypted vault and are referenced
by name; they never enter a workflow definition, a prompt, or a log.

Details: [Architecture overview](docs/concepts/overview.md) ·
[Governance & audit](docs/concepts/governance-and-audit.md) ·
[Reversibility & trust domains](docs/concepts/reversibility-and-trust-domains.md). Diagram
source: [`docs/concepts/overview.drawio`](docs/concepts/overview.drawio).

---

## Documentation

Everything lives in [`docs/`](docs/) — start with the [docs index](docs/README.md), or the
[glossary](docs/concepts/glossary.md) when a term is doing work you do not recognise.

The pages that answer the most common next questions:

- [AI-assisted authoring](docs/authors/authoring-workflows.md) — the full build → test →
  patch → approve loop, including throwaway drafts and partial-accept of single edits.
- [Connectors & integration](docs/concepts/connectors.md) — how a system gets connected,
  including bootstrapping one from an OpenAPI or Google REST Discovery document.
- [Input surfaces](docs/developers/input-surfaces.md) — every door into sk, and what each
  one carries. Remote AI clients connect through sk's own OAuth 2.1 authorization server;
  that section covers login, consent, scopes, and token revocation.
- [Observability & usage reports](docs/operators/observability.md) — how to see how sk is
  actually used without collecting anyone's content.

Point a model at [`docs/llms.txt`](docs/llms.txt) for an index it can follow, or
[`docs/llms-full.txt`](docs/llms-full.txt) for the whole set in one fetch.

---

## For coding agents

sk is built to be worked on by agentic coding environments. Start with
[`AGENTS.md`](AGENTS.md) — the canonical repo-wide contract, subsystem map, and quality
gate. Then [`SKILLS.md`](SKILLS.md) for the skill index, the
[tool palette](docs/developers/tool-palette.md) for the callable tools, and the
[authoring guide](docs/authors/authoring-workflows.md) for the loop your agent drives.

---

## Contributing

Contributions are welcome — bug reports, docs fixes, connectors, features.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, test layers, and the PR checklist;
issues labeled [`good first issue`](https://github.com/mikebild/subkit/labels/good%20first%20issue)
are curated entry points. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md); security reports go through
[`SECURITY.md`](SECURITY.md), never public issues.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Mike Bild
