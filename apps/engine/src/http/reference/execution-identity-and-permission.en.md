---
slug: execution-identity-and-permission
summary: Who runs an execution and which permissions apply to it.
section: operate
order: 4
audience: operator
---
## Execution identity and permission

Chat keeps local workflow edits when a saved draft changes concurrently. Saving,
activating and running are separate outcomes. After you activate a prepared change
in DEV, its recorded test inputs can be used for one live test under the existing
execution permission. A request not to run live prevents this continuation. PROD
requires an explicit live-run request. The recorded run shows what actually happened.

The chat's model cost is an approximate calculation from reported provider usage
and configured prices, not an invoice. Its token count includes repeated context
across model calls. Open **Changes** in the lower-left account menu for short release
notes; unpublished changes are listed separately.

`$caller` answers who authenticated this execution. Connector credentials authenticate an outbound request to another service. RBAC decides which workflows and resources that principal may use. Human approval permits a reviewed effect boundary for an environment. These four concepts are independent: a credential or approval does not create caller identity or replace authorization, and the approver need not be the execution caller.

HTTP and MCP runs derive caller identity from their authenticated principal. Trusted callerless webhook and scheduled runs receive `null`; the person who configured or approved them is not automatically their caller. Child workflows retain the parent's caller. Use `required_caller_kind` and `product_id` when a workflow requires a particular authenticated identity, and never infer one from input fields or `request_source`.

Run inspection exposes source, status, workflow version, execution authority, step evidence and a safe `caller` summary through HTTP and MCP. The summary names the stored principal, product, authentication method, channel and origin run without exposing credentials or session identifiers. Missing stored identity is `kind: unknown`; a channel alone cannot identify a caller. HTTP audit queries and MCP `list_audit` can filter by actor and trace. These records provide partial correlation, not a complete caller timeline. See the built-in Core Concepts, Auth Flows and REST API guidance for the contract and its limits.

