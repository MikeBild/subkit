---
slug: supabase-backed-product-workflows
summary: Use your Supabase project's data in product workflows without exposing keys.
section: operate
order: 7
audience: operator
---
## Supabase-backed product workflows

With the `supabase` connector your product workflows reach your Supabase project without direct PostgreSQL access and without SQL steps. You need this when an app should read or change its users' data through SubKit. Afterwards every key sits encrypted on the connector, and you reach user-owned data through the verified caller instead of a user token passed along.

This section covers the `supabase` connector only. It does not matter which identity provider signs the app's users in. You author workflows as usual.

### Credentials on the connector

Store the required gateway headers as encrypted connector credentials:

- `apikey` is the public project key.
- `Authorization` carries the JWT (a signed token) for the intended database role.
- `x-subkit-token` may additionally be required by a protected server-to-server RPC. It is stored only on the connector and identifies SubKit to your product backend. It is not the end user's identity and never replaces the workflow's immutable `$caller`.

Do not use `service_role` for access on behalf of a caller: this role bypasses RLS, the database's row-level access rules. Never put credentials in app code, workflow inputs or steps, client context, generated workflow source, or logs.

### Data of individual users

A connector credential applies to the whole tenant and cannot represent separate mobile users. Never pass an app user's JWT as workflow input for that reason. When a workflow needs user-owned data, use an RPC, meaning a database function behind an endpoint, that derives the owner from the immutable `$caller`.

Bind product workflows to their product and the required caller kind. Derive owner identifiers from `$caller`. If an atomic authorization or quota reservation does not explicitly permit the next step, the workflow must fail closed instead of continuing.
