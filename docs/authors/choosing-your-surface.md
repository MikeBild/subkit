# Choosing your surface

> **Reading time:** ~9 min
> **Audience:** Anyone building or running workflows with an AI assistant

**Do the work where it actually goes faster.** sk meets you in a browser chat, in your terminal, and in your coding agent — but those doors are not interchangeable. Pick the wrong one and a five-minute edit becomes an afternoon of describing the same change over and over. This page tells you which door fits which job, and how to notice mid-task that you are standing at the wrong one.

---

## One question

> **Am I changing a definition, or running one?**

Everything else follows from the answer.

| | **Change a definition** | **Run one** |
|---|---|---|
| Use | a coding agent (Claude Code, Codex, …) + the `sk` CLI | claude.ai / ChatGPT over MCP |
| Why | you write the exact definition; nothing paraphrases it | built for this, low friction, no setup |

A browser client is not a weaker tool. It is a tool for a different job. It runs workflows, reads results, and reasons about what came back — and it does all of that well. What it cannot do is write a workflow definition directly. Ask it to, and your sentence has to travel through a second model that interprets it.

## Seven examples

### 1. "In `normalize`, take the timestamp from the collection metadata, not the clock."

**Wrong door — browser chat.** Your sentence becomes an instruction to an authoring model, which turns it into an edit. The edit may land somewhere else than you meant, and you often find out only after it is live.

**Right door — your terminal:**

```bash
sk workflows get <id> > normalize.json
# edit the one line
sk workflows validate normalize.json
sk workflows preview  normalize.json
sk workflows update   <id> --file=normalize.json
```

You see the diff. The change is the change you wrote.

`update` runs `validate` and `preview` itself before writing, so the two explicit
steps above are for reading the result yourself — the point of the whole exercise.
An unchanged definition does not rotate a version.

### 2. "Roll back to the previous version."

**Wrong door — browser chat.** Version restore is a tenant write, and the authoring surface publishes none of those except running a workflow. The tool is not in the client's catalogue at all, so the assistant cannot see it — and tends to propose detours rather than say "I cannot reach that."

**Right door — your terminal**, where restoring safely also means reading the history first:

```bash
sk workflows history <id>
sk workflows restore <id> <version>
```

Never guess the version number. Restoring is not a repair: if you do not know which version was good, find out before you replace what is live.

### 3. "Prove that two runs produce identical output."

**Wrong door — browser chat.** The client sees only what a tool hands back. It cannot compare two artefacts byte for byte, so it will answer the question by reasoning about it — which sounds like a proof and is not one.

**Right door — run it twice and compare the checksums yourself.** Determinism claims need a diff, not an argument.

### 4. "Run the weekly report and tell me what stands out."

**Right door — browser chat.** This is exactly what it is for: call the workflow, read the result, notice the outlier, ask a follow-up. No setup, no files, no CLI.

### 5. "Keep these five related workflows consistent."

**Wrong door — browser chat.** Each conversation carries its own context. The convention you established in the first workflow has quietly drifted by the fifth, and nothing shows you that it did.

**Right door — the repo.** Five files, one commit, one review. Consistency becomes something you can see rather than something you hope for.

### 6. "Approve this proposal."

**Wrong door — an in-band confirmation.** Some clients render their own approval dialog; when a client does not, the request degrades to a link that has to be opened in time. Often it is not, and the decision quietly expires.

**Right door — approve in the portal or the CLI**, deliberately, where the decision is visible and recorded.

### 7. "Sketch me something in this direction."

**Right door — browser chat**, for the *first draft*. Exploring, shaping, throwing away, trying again: this is where a conversational surface is strongest.

Then export it and continue in the repo. The handover belongs exactly where an idea turns into a definition — not later.

## Warning signs you are at the wrong door

Any one of these means stop and switch, not try again:

- You have described the same change three times.
- The assistant **runs** the thing instead of changing it.
- A dry run reported green and nobody actually read the result.
- You are waiting on a confirmation that never arrives.
- You cannot say which version is currently live.

The last one is the most expensive, because it is the one you notice last.

## What a browser client cannot do — and why that is deliberate

A browser client connects in **authoring mode**, which publishes the conversation tools, tenant reads, and exactly one write: running a workflow. Concretely:

- **No tenant writes reach the catalogue.** `restore_workflow_version` and `update_workflow` are not listed, so the assistant cannot call them — asking returns "no tool named that is available on this surface." `run_workflow` is the deliberate exception: it runs a workflow rather than mutating a definition.
- **The step-level editors are not in the catalogue either** — in any mode, including admin. `edit_workflow_patch`, `save_workflow_draft`, `dry_run_workflow`, and `validate_draft` are omitted from the tool list, and calling one directly is refused rather than silently failing. They are driven by sk's own authoring loop inside a conversation, never by the external client.
- **No tool accepts a full workflow definition.** There is no MCP equivalent of `PUT /v1/workflows/{id}`.
- **A broader credential does not widen this.** Even a wildcard scope resolves to authoring, and authoring withholds tenant writes unconditionally — no key changes that. The admin surface is a separate, explicitly requested scope.

So every definition edit over MCP routes through the authoring conversation, where a model turns your sentence into the patch. That is a deliberate boundary, not an oversight: a definition edit should pass through something a person can read. Mechanics in [Input Surfaces → MCP Integration](../developers/input-surfaces.md#mcp-integration); the reasoning in [Reversibility & Trust Domains](../concepts/reversibility-and-trust-domains.md).

## Green is not the same as correct

A dry run checks that the workflow **executes**. It does not check that the result is **right**.

A workflow can read the wrong field, produce empty values for every record, and finish without a single error — green, and wrong. If you did not read the preview, you have confirmation that nothing crashed and nothing more.

This matters most on an **unattended turn** — a background client with no way to surface a prompt. A deferral there would strand the work mid-flight, so sk commits instead. What it commits, and what it holds back, is worth knowing exactly:

| Unattended turn, dry run green | Outcome |
|---|---|
| the preview judge returned a verdict | commits |
| judge skipped, and the workflow is **new** | commits — there is nothing to lose |
| judge skipped, and it would **replace** an existing workflow | **held back** |

That last row exists because the alternative went wrong in production: an unjudged green preview once landed a generic normaliser on top of a purpose-built one, and "green" there meant only "no exception". Replacing verified work now needs more than an absent objection.

The first two rows still commit without anyone agreeing to it. An auto-commit is not evidence a person reviewed anything — it tells you the run was clean, not that it was right.

Read the preview. Especially when it is green.

## Further reading

- [Reversibility & Trust Domains](../concepts/reversibility-and-trust-domains.md) — why authoring and execution are different jobs
- [Use sk from a coding agent](coding-agents.md) — connecting Claude Code, Codex, and other clients
- [AI-Assisted Authoring](authoring-workflows.md) — the full authoring loop
- [Input Surfaces](../developers/input-surfaces.md) — every door and what it carries
