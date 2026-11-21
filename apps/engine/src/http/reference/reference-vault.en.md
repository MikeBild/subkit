---
slug: reference-vault
title: Reference: the vault
summary: Keep API keys, logins and connector credentials in the vault, use them by handle in workflows, and see who used them when.
section: reference
order: 10
audience: public
---
## Reference: the vault

The vault is the one place for every secret in your workspace: API keys, logins and the credentials of your connectors.
A workflow names an item only by its handle. SubKit fills in the value when an approved run executes the step. The AI never sees it.

### What the vault holds

| Kind | For | Fields |
| --- | --- | --- |
| Secret | an API key or token that several workflows need | `token` |
| Login | a username and a password | `username`, `password` |
| Connector credential | a connector's credential, created when you connect it | depends on the sign-in type |
| Template client | the OAuth client of a connector template | `client_id`, `client_secret` |

You add and change secrets and logins in the vault. You change connector credentials and template clients on the connector. The vault shows them and lets you reveal or delete them.

Every item has a name of lowercase letters, digits, `-` and `_`, for example `crm-token`. The name is also the handle. It applies per environment: `crm-token` in test and `crm-token` in production are two items.

### Who an item is for

| Scope | Who sees it | When its value is filled in |
| --- | --- | --- |
| Workspace | everyone with `vault:read`, metadata only | in every approved run of the workspace |
| Only me | only you | only in runs you start |
| This device | only SubKit Desktop on this device | never in workflows; it stays on the device |

SubKit Desktop creates device items itself, for example the key the device uses to identify itself to the server. They are encrypted in the operating system's secure storage and never leave the device.

### Use an item in a workflow

Write the handle into a header of a request step that has a connector:

```json
{
  "id": "contacts",
  "kind": "request",
  "connector_id": "<crm-connector-id>",
  "method": "GET",
  "path": "/contacts",
  "headers": { "authorization": "Bearer ${secret.crm-token}" },
  "boundary": { "variables": {}, "max_body_bytes": 0, "max_calls": 1 }
}
```

| Form | Meaning |
| --- | --- |
| `${secret.crm-token}` | the token of a workspace secret |
| `${secret.erp.username}`, `${secret.erp.password}` | the fields of a login |
| `${secret.me.crm-token}` | your own “Only me” item |

These rules always apply:

- **The approval names the items.** It shows “Uses from the vault: crm-token, …” and binds the names, never the values. A new version that uses another item needs a new approval. Fewer items carry the approval forward.
- **Approved runs only.** In drafts, test runs and held steps the handle stays unresolved (`secret_withheld`) and nothing is sent.
- **Own connector only.** A step that carries a vault value may only go to its connector's origin. Any other address stops with `credential_boundary_violation` before anything is sent.
- **Headers only.** In the path, query, URL or body a handle stays unresolved or makes the step unapprovable.
- **A missing item fails the step** with `placeholder_unresolved`, and nothing is sent.

### What the AI and the records see

The AI, chat, MCP and the sk CLI get the name, kind, scope, environment, version and last use, never the value.
A run's result, error message, log and audit trail do not contain the value. SubKit replaces it, also URL- or JSON-encoded, with `***redacted***`.

### Rotation

**Replace value** in the vault or `sk vault rotate` stores a new value and raises the version. The next run uses it. The workflow's approval stays valid, because it binds the handle, not the value.
You rotate the engine's master key (`MASTER_KEY`) with the rewrap maintenance, as before.

### Reveal and activity

**Reveal** shows you the value for a short time, and `sk vault reveal <id> --yes` prints it in the terminal. Every reveal is in the audit trail.
An item's activity shows when it was created, used, revealed, rotated or deleted. A use names its run and step.

### Permissions

| Permission | Default | Allows |
| --- | --- | --- |
| `vault:read` | all roles | seeing workspace items, without values |
| `vault:write` | admin | adding items and describing them |
| `vault:rotate` | admin | replacing values |
| `vault:delete` | admin | deleting items |
| `vault:reveal` | admin | revealing the values of workspace items |

You always manage your own “Only me” items, even without these permissions.

### In the Cockpit, with sk and over MCP

- **Cockpit:** Settings › Vault.
- **sk:** `sk vault list`, `show`, `add`, `rotate`, `reveal`, `refresh`, `rm`, `attach` and `connector`. `add` and `rotate` read the value from stdin or a hidden prompt, never from arguments.
- **MCP:** `list_vault_items` and `get_vault_item` return metadata only.
- **HTTP:** `/v1/vault`, see the HTTP API.

### Backup and moving

A server backup needs the database and the `MASTER_KEY`. Without it the values cannot be opened.
A package or a move to another workspace takes names and metadata only, never values. There is no plain-text export.
