---
slug: execution-identity-and-permission
summary: See who triggered a run and what it may do.
section: operate
order: 4
audience: operator
---
## Execution identity and permission

Every run involves four separate things: who triggered it, how it signs in, what it may do and what a person approved. You need this chapter when a workflow should run only for particular signed-in people or apps, or when you want to attribute a run afterwards. Afterwards you know where to find a run's identity and which details cannot establish it.

### The four concepts

- `$caller` answers who authenticated this run.
- Connector credentials authenticate an outbound request to another service.
- RBAC, role-based access control, decides which workflows and resources that principal may use. A principal is the authenticated identity, meaning a person, an app or a key.
- A person's approval permits a reviewed reach of effect for an environment.

The four are independent. A credential or an approval does not create caller identity and does not replace authorization. The approver need not be the run's caller.

### Who the caller is

HTTP and MCP runs take the caller from their authenticated principal. Trusted callerless webhook and scheduled runs receive `null`. Whoever configured or approved them does not automatically become their caller. Child workflows keep the parent's caller.

If a workflow should run only for a particular authenticated identity, set `required_caller_kind` and `product_id`. Never infer that identity from input fields or `request_source`.

### Trace a run

Through HTTP and MCP every run shows source, status, workflow version, execution authority, step evidence and a safe summary under `caller`. It names the stored principal, product, authentication method, channel and origin run, but no credentials and no session identifiers. If the stored identity is missing, it shows `kind: unknown`; a channel alone does not identify a caller.

HTTP audit queries and MCP `list_audit` filter by actor and trace. These records correlate only partially and do not form a complete caller timeline. The exact rules and their limits are in the built-in Core Concepts, Auth Flows and REST API guidance.

### Task runs

A task is a goal with limits that SubKit works towards on its own. For a run of a task, the four concepts read like this:

- **Who it is.** A run acts as the owner of the task, also when a schedule started it and nobody is signed in. Every record of the run carries the access type “task run” with the task and the run, so you can tell it apart from what the owner did by hand.
- **What it may do.** The owner’s role is the upper bound. Within it, the run may only start the workflows and call the connectors bound to the task, in the environment of the task. It cannot create or change workflows, and it cannot start a workflow with `execution_privacy: sensitive`.
- **What a person approved.** A start by hand allows that one run. A start on a schedule needs the standing permission of the task. It is tied to the content of the task: any change to the goal, the plan, the bindings, the schedule, the limits or the environment ends it. A new name does not. Whether a bound workflow may write is decided by the approval of that workflow: when a valid one covers the start, the workflow writes without asking, also when the task has no standing permission. Otherwise its writes are held back and the run asks.
- **Who approved.** The standing permission is given by a person signed in to the Cockpit in the browser, the owner or an admin. That person is recorded as the approver and does not become the caller of the runs.

Before every background round, SubKit checks again that the owner is still active, the run is still open, the task is neither paused nor archived, and the standing permission of the run has not been revoked. If one of these fails, the round does not run.

A person who writes into a run does not widen it. The owner and admins can write; the same limits apply to their rounds, and the run cannot be switched to a mode that stops asking. Writes that a run holds back are released by the owner or an admin. They are carried out with the permissions of the run, not with those of the admin, and the audit trail names the person who decided. A result is confirmed or sent back by a person signed in to the Cockpit in the browser, not with an API key, in `sk` or from an AI client.

In the audit trail, background work of a run is recorded as the system with the scheduler or the queue as its source. Approvals, confirmations and stops name the person who acted. The entries hold identifiers, states and reason codes, never the goal text or an answer.

### In chat: draft, run and cost

If a saved draft changes while you work on it in chat, chat keeps your local edits. Saving, activating and running are separate steps with their own outcome. After you apply a draft in DEV, a single run with the recorded test inputs starts only when you tick **Start a run afterwards**. If you ask not to run live, this run does not happen. In PROD a live run needs an explicit request.

The recorded run shows what actually happened. The chat's model cost is an estimate from the provider's reported usage and the configured prices, not an invoice. The token count includes context that is sent repeatedly across model calls. Short release notes are under **Changes** in the lower-left account menu; unpublished changes are listed separately there.
