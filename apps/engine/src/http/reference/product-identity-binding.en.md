---
slug: product-identity-binding
summary: Bind your product's signed-in users to a minimal SubKit identity.
section: operate
order: 5
audience: operator
---
## Product identity binding

For an OIDC provider configured with `product_id`, an operator first provisions an active tenant user, assigns a minimal custom role and grants only the intended saved workflows. Built-in member roles allow broader workflow execution.

Bind its verified issuer subject with `POST /v1/identity/users/{id}/provider-identities` and JSON `{"provider_id":"<provider-id>","subject":"<verified-subject>"}`. This requires administrator policy and `identity:write`. Tenant, issuer and product come from provider configuration. Exact retries are idempotent; owner, subject, issuer or product conflicts are refused. The endpoint changes neither roles nor grants.

Product providers require this binding and disable account creation and email linking even when signup is globally enabled. Older product bindings need an operator to pin the same owner and subject before login. Unbound providers retain email linking by default; set `link_by_email: false` to disable it. Older unbound bindings pin the configured issuer at their first verified login; this cannot establish historical issuer provenance.

Pins are checked for new logins. Changing provider configuration does not revoke existing browser sessions; revoke those separately or let their configured lifetime expire.

