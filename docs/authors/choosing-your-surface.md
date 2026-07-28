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
sk workflows update <id> normalize.json
```

You see the diff. The change is the change you wrote.

### 2. "Roll back to the previous version."

**Wrong door — browser chat.** Version restore is a tenant write, and the MCP authoring surface does not carry those. The tool is not in the client's catalogue at all, so the assistant cannot see it and will propose detours instead of saying "I can't reach that."

**Right door:**

```bash
sk workflows history <id>
sk workflows restore <id> <version>
```

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

Over MCP, the authoring surface publishes reads plus the ability to run a workflow. It does **not** publish other tenant writes. Specifically:

- **Draft-editing tools are not in the catalogue**, and calling one directly is refused rather than silently failing. They are driven by sk's own authoring loop inside a conversation, never by the external client.
- **There is no MCP equivalent of `PUT /v1/workflows/{id}`.** No tool accepts a full workflow definition.
- **`update_workflow` over MCP changes metadata only** — name, description, lifecycle. It refuses when the draft has uncommitted step edits, rather than reporting success while those edits stay unsaved.
- **A broadly scoped key does not change this.** Even a wildcard scope resolves to the authoring surface; the admin surface requires its own explicit scope.

This is a deliberate boundary, not an oversight: a definition edit should pass through something a person can read. Mechanics in [Input Surfaces → MCP Integration](../developers/input-surfaces.md#mcp-integration); the reasoning in [Reversibility & Trust Domains](../concepts/reversibility-and-trust-domains.md).

## Green is not the same as correct

A dry run checks that the workflow **executes**. It does not check that the result is **right**.

A workflow can read the wrong field, produce empty values for every record, and finish without a single error — green, and wrong. If you did not read the preview, you have confirmation that nothing crashed and nothing more.

This matters most on an **unattended turn**. When a confirmation cannot be delivered — a background client with no way to surface a prompt — sk commits a green dry run rather than leaving the work stranded mid-flight. That behaviour is deliberate, and it means an auto-commit is not evidence a person agreed. On those surfaces, "it committed" tells you the run was clean, not that it was reviewed.

Read the preview. Especially when it is green.

## Further reading

- [Reversibility & Trust Domains](../concepts/reversibility-and-trust-domains.md) — why authoring and execution are different jobs
- [Use sk from a coding agent](coding-agents.md) — connecting Claude Code, Codex, and other clients
- [AI-Assisted Authoring](authoring-workflows.md) — the full authoring loop
- [Input Surfaces](../developers/input-surfaces.md) — every door and what it carries
