---
slug: reference-vault
title: Reference: the vault
summary: Keep API keys, logins, cards, bank accounts and other private data in the vault, use them by handle in workflows and by name in the browser, and see who used them when.
section: reference
order: 10
audience: public
---
## Reference: the vault

The vault is the one place for every secret in your workspace: API keys, logins with one-time codes, payment cards, bank accounts, identity documents, addresses, secure notes and the credentials of your connectors.
A workflow or a browser task names an item only by its handle. SubKit fills in the value when an approved run executes the step or when you approve the sign-in or payment. The AI never sees it.

### What the vault holds

| Kind | For | Fields |
| --- | --- | --- |
| Secret | an API key or token that several workflows need | `token` |
| Login | a username and a password, optionally a one-time code key (TOTP) and the websites it belongs to | `username`, `password`, `totp_seed` |
| Card | a payment card, never its CVV | `number`, `exp_month`, `exp_year`, `holder` |
| Bank account | an account for transfers and direct debits | `iban`, `bic`, `holder` |
| Identity | an ID document or personal data | `full_name`, `birth_date`, `document_type`, `document_number`, `nationality` |
| Address | a postal address with phone and email | `name`, `line1`, `line2`, `postal_code`, `city`, `region`, `country`, `phone`, `email` |
| Secure note | a private text | `text` |
| Connector credential | a connector's credential, created when you connect it | depends on the sign-in type |
| Template client | the OAuth client of a connector template | `client_id`, `client_secret` |

You add and change secrets, logins, cards, bank accounts, identities, addresses and notes in the vault. You change connector credentials and template clients on the connector. The vault shows them and lets you reveal or delete them.

SubKit checks the values when you save them:

- **Card:** the number must pass the Luhn check, and the expiry date must lie in the future. SubKit recognizes the brand itself.
- **Bank account:** the IBAN must have a valid checksum, and a BIC must have the right format.
- **Login:** the one-time code key is a base32 key or an `otpauth://` link with 6 digits, 30 seconds and SHA1. Each website is an origin like `https://members.example.com`. Plain `http` is accepted only for addresses on your own device.

Every item has a name of lowercase letters, digits, `-` and `_`, for example `crm-token`. The name is also the handle. It applies per environment: `crm-token` in test and `crm-token` in production are two items.

### Who an item is for

| Scope | Who sees it | When its value is filled in |
| --- | --- | --- |
| Workspace | everyone with `vault:read`, metadata only | in every approved run of the workspace |
| Only me | only you | only in runs you start |
| This device | only SubKit Desktop on this device | never in workflows; it stays on the device |

Cards, bank accounts and identities are always “Only me”. SubKit refuses them in the workspace scope, and nobody else can use them, not even an admin.

SubKit Desktop creates device items itself, for example the key the device uses to identify itself to the server. They are encrypted in the operating system's secure storage and never leave the device.

### Use an item in a workflow

Write the handle into a header, a query value, a `form` field or the body of a request step that has a connector:

```json
{
  "id": "contacts",
  "kind": "request",
  "connector_id": "<crm-connector-id>",
  "method": "GET",
  "path": "/contacts",
  "headers": { "authorization": "Bearer ${secret.crm-token}" },
  "query": { "account": "${secret.crm-account}" },
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
- **Headers, query, form and body only.** In the path, the URL, a GraphQL query or an MCP call a handle is never resolved; in the path or URL the step stops before anything is sent.
- **The same rules everywhere.** A handle in the query, a form field or the body is resolved, redacted and approved exactly like one in a header. A query value may hold fixed text around a handle but no other placeholder; the approval checks that the key is sent, not its value, so a rotation needs no new approval.
- **A missing item fails the step** with `placeholder_unresolved`, and nothing is sent.

Only secrets and logins can be used in workflow requests. Cards, bank accounts, identities, addresses and notes have no handle for requests. Logins and cards are used in the browser, see [Sign in and pay in the browser with the vault](setup.md#sign-in-and-pay-in-the-browser-with-the-vault).

### What the AI and the records see

The AI, chat, MCP and the subkit CLI get the name, kind, scope, environment, version and last use, never the value. For the new kinds they also get a masked summary:

| Kind | What is shown |
| --- | --- |
| Login | the first two characters of the username, whether a one-time code key is stored, the websites |
| Card | brand, last four digits and expiry, for example “Visa •••• 4242, 12/2030” |
| Bank account | the last four characters of the IBAN and the country |
| Identity | a short label |
| Address | city and country |
| Secure note | nothing but the name |

A card number, IBAN, CVV or one-time code that you type into a chat is withheld before the AI reads the message. The chat then shows `***REDACTED:card***`, `iban`, `cvv` or `otp` in its place.
A run's result, error message, log and audit trail do not contain the value. SubKit replaces it, also URL- or JSON-encoded, with `***redacted***`.

### Rotation

**Replace value** in the vault or `subkit vault rotate` stores a new value and raises the version. The next run uses it. The workflow's approval stays valid, because it binds the handle, not the value.
You rotate the engine's master key (`MASTER_KEY`) with the rewrap maintenance, as before.

### Reveal and activity

**Reveal** shows you the value for a short time, and `subkit vault reveal <id> --yes` prints it in the terminal. Every reveal is in the audit trail.
For a card or a bank account you must also have signed in within the last 5 minutes. Otherwise SubKit asks you to sign in again first. A card never has a CVV to reveal, because SubKit never stores it.
An item's activity shows when it was created, used, revealed, rotated or deleted. A use names its run and step.

### Permissions

| Permission | Default | Allows |
| --- | --- | --- |
| `vault:read` | all roles | seeing workspace items, without values |
| `vault:write` | admin | adding items and describing them |
| `vault:rotate` | admin | replacing values |
| `vault:delete` | admin | deleting items |
| `vault:reveal` | admin | revealing the values of workspace items |
| `vault:use` | member | using workspace logins in the browser |

You always manage your own “Only me” items, even without these permissions.

### In the Cockpit, with subkit and over MCP

- **Cockpit:** Settings › Vault.
- **subkit:** `subkit vault list`, `show`, `add`, `rotate`, `reveal`, `refresh`, `rm`, `attach` and `connector`. `add` and `rotate` read the value from stdin or a hidden prompt, never from arguments.
- **MCP:** `list_vault_items` and `get_vault_item` return metadata only.
- **HTTP:** `/v1/vault`, see the HTTP API.

### Import

You can import logins, including their one-time code keys and websites, from a CSV export of Chrome, 1Password or Bitwarden: **Settings › Vault › Import CSV** in the Cockpit. SubKit first shows a preview of what it found; then you import the new entries. Entries whose name already exists are skipped. Cards and other kinds are not imported.

### Limits

- **No CVV.** SubKit never stores a card's security code. You enter it in the payment approval each time you pay.
- **No PCI DSS certification.** SubKit is not certified under PCI DSS and makes no such claim. Store cards only for your own payments in the browser, never cards of your customers.
- The vault protects values with AES-GCM and the engine's `MASTER_KEY`. Anyone who holds the database and the `MASTER_KEY` can open them.

### Backup and moving

A server backup needs the database and the `MASTER_KEY`. Without it the values cannot be opened.
A package or a move to another workspace takes names and metadata only, never values. There is no plain-text export.
