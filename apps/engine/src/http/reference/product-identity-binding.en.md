---
slug: product-identity-binding
summary: Link your app's users to a SubKit account with minimal rights.
section: operate
order: 5
audience: operator
---
## Product identity binding

With an identity binding, a user of your app who signs in through your own sign-in service lands on exactly one prepared account in SubKit. You need it when an app or customer portal should start selected workflows without its users getting full SubKit accounts. Afterwards every sign-in is bound to an account with minimal rights, and no new accounts appear on their own.

Three terms first. A product is your own app or service, which you mark in SubKit with `product_id`. OIDC (OpenID Connect) is a standard through which an external sign-in service, the issuer, confirms who signed in. The subject is the stable user identifier that this issuer provides.

### Prepare the account

For an OIDC provider configured with `product_id`, you as operator prepare the account first:

1. Create an active user in the tenant.
2. Give it a custom role with minimal rights.
3. Grant it only the intended saved workflows.

Do not use a built-in member role for this. It allows running considerably more workflows.

### Bind the subject

Bind the issuer's verified subject to this user:

```http
POST /v1/identity/users/{id}/provider-identities

{"provider_id":"<provider-id>","subject":"<verified-subject>"}
```

This requires administrator policy and `identity:write`. Tenant, issuer and product come from the provider configuration. An exactly repeated request changes nothing. If it conflicts with an existing binding on owner, subject, issuer or product, SubKit refuses it. The endpoint changes neither roles nor grants.

### What applies at sign-in

Product providers require this binding. They create no accounts and link none by email address, even when signup is enabled globally. For older product bindings, an operator must pin the same owner and subject before sign-in.

Providers without a product binding link by email address by default; `link_by_email: false` turns that off. Older bindings without a product pin the configured issuer at their first verified sign-in. That cannot establish which issuer applied earlier.

Pins are checked for new sign-ins. If you change the provider configuration, existing browser sessions stay valid. Revoke them separately or let their configured lifetime expire.
