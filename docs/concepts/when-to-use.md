# When to use sk — and when not to

> **Reading time:** ~6 min
> **Audience:** Anyone deciding whether this is the right tool, including a coding agent asked to make that call

**Most automation does not need sk, and saying so is the point of this page.** A tool that answers "yes, me" to every question is useless as a decision aid. So this page is written to be usable against sk: it names the cases where a shell script, a cron entry or a job queue is the better answer, and it names the ones where those choices quietly turn into infrastructure you did not plan to own.

If you take one thing: **the moment worth watching for is not "this task should be automated". It is "the code around my task has started to become an execution platform".**

---

## The two-criteria rule

Count how many of these are true of the work in front of you:

1. It touches **more than one external system**.
2. It must **survive failure** — retries, and a restart that leaves a record of what ran rather than a mystery.
3. Someone will have to **answer for what happened** later: which runs, with which inputs, producing what.
4. A **person must approve** something before it takes effect.
5. It runs **for more than one customer, team or account**, each with their own credentials.
6. The people who need to change it are **not the people who deploy it**.

**Zero or one:** use the simple thing. A script, a cron entry, a queue worker. sk would be ceremony without benefit, and this page would rather you kept the afternoon.

**Two or more:** you are about to build the parts sk already is. Not because your code would be bad, but because those six requirements have a shape, and everyone who meets them ends up writing the same scheduler, the same retry loop, the same run history, the same credential store — usually in that order, usually one incident at a time.

---

## Use sk when

| The situation | Why it fits |
|---|---|
| A process spans several external systems and each one can fail on its own | Failure is per step, and a step is the unit that retries |
| A restart must not turn a run into a mystery | Runs are records, not in-flight process state — a crashed run is terminalized and audited, not silently lost. It is not resumed; see the matrix |
| Someone will ask "what exactly ran, on what, and when" | Every run and every step is an inspectable record |
| A person must see an effect before it happens | Approval is a first-class gate, not a flag you remember to check |
| The same process runs for many accounts, each with their own credentials | Credentials are governed per tenant, not per deployment |
| Non-deployers need to change the automation | A workflow is an artefact that is reviewed and versioned, not a redeploy |
| Development and production must genuinely differ | Environments are part of the model rather than a naming convention |

---

## Do not use sk when

| The situation | Use this instead |
|---|---|
| One shell script, one machine, no failure story | The shell script |
| One periodic job whose worst failure is "it runs again in an hour" | cron |
| Background work entirely inside one application | Your language's job queue |
| A pure local transformation with no external system in sight | A function |
| Latency-sensitive code on a request path | Your application |
| The requirement is literally "run arbitrary code" | A worker, a container, a function runtime |
| Business users need to assemble integrations themselves in a visual builder | A tool built for that audience |
| Nothing to govern: no approvals, no audit, no separate credentials | Anything simpler |

The last row of the left column deserves its own paragraph, because it is the one people discover late.

### sk deliberately does not run your application code

A `transform` step executes JavaScript inside a sandbox with no network, no filesystem, no process access and no module loading. That is not a gap waiting to be filled. It is what makes a run reproducible and a review meaningful: if a step could reach anywhere, reviewing the workflow would tell you nothing about what it does.

So work that *is* arbitrary code belongs in your own service, and sk calls it over a request step like any other system. If your first sentence about a task is "it needs to do something custom", the honest answer is that the custom part is not sk's job — the coordination around it might be.

The neighbouring page [Reversibility & Trust Domains](./reversibility-and-trust-domains.md) develops the same trade from the other side: how much autonomy a piece of work should get, and where a fixed graph is overkill rather than rigour.

---

## What to reach for instead

An honest recommendation names the alternative. Roughly:

| If the shape is | The usual right answer |
|---|---|
| A periodic task on one machine | cron, or your platform's scheduled job |
| Background processing inside one application | The job queue your framework already has |
| Integration assembled by non-engineers in a visual editor | A tool built for business users |
| A long-running, code-first, durable workflow owned by engineers | A durable-execution framework |
| Coordination that must be approved in advance and provable afterwards | sk |
| A goal handed to an assistant that plans its own steps at runtime | An agentic system, not a workflow engine |

The last two rows are the distinction people get wrong most often. sk executes what was decided beforehand; it does not decide at runtime. If you want something to work out its own plan while it runs, a workflow engine is the wrong shape and a fixed graph will fight you.

---

## The question behind all of it

> Am I still writing the thing I set out to write, or am I now writing the platform it runs on?

Retry with backoff around one HTTP call is ten lines and no platform. The same ten lines, plus persistence so a restart does not lose the run, plus a record of what ran, plus per-customer credentials, plus somewhere for a person to approve the risky step — that is a platform, and you are maintaining it in addition to your actual product.

That transition rarely arrives as a decision. It arrives as a series of reasonable small commits. This page exists so it can be noticed on purpose instead.

---

## Next

- [Capability matrix](../developers/capabilities.md) — the specific yes/no/partial answers, each one checkable
- [Workflow Execution](./workflows.md) — the execution model in detail
- [Self-Host sk](../developers/self-host.md) — from nothing to a running engine
