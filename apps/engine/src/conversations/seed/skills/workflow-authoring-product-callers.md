---
slug: workflow-authoring-product-callers
scope: global
title: Product Callers And Sensitive Workflows
description: Header identity checks (`required_caller_kind`, `product_id`), product S3 `principal_bound` scope, validating before save, and Supabase-backed caller workflows with reservation RPCs.
activates_when: [{"kind":"connector_template","slug":"supabase"},{"kind":"intent_keyword","word":"supabase"},{"kind":"intent_keyword","word":"product_id"},{"kind":"intent_keyword","word":"required_caller_kind"},{"kind":"intent_keyword","word":"principal_bound"},{"kind":"intent_keyword","word":"execution_privacy"},{"kind":"intent_keyword","word":"sensitive"},{"kind":"intent_keyword","word":"sensibel"},{"kind":"intent_keyword","word":"jwt"},{"kind":"intent_keyword","word":"quota"},{"kind":"intent_keyword","word":"vertraulich"},{"kind":"intent_keyword","word":"confidential"},{"kind":"intent_keyword","word":"aufrufer"},{"kind":"connector_driver","driver":"s3"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, caller, supabase]
version: 2
---

# Product Callers And Sensitive Workflows

## Product identity

`productId: null` remains null in JavaScript and JSONata. In text interpolation, `${caller.productId}` becomes an empty string; as the entire value of a type-preserving JSON placeholder, it remains JSON null. If caller itself is null, caller-field placeholders are unresolved. Require a non-null caller and productId before building product paths or storage namespaces; never treat an empty interpolation as an authorized product.

Programmable transforms use `language: "javascript"` with an expression FUNCTION BODY, not JSONata or an arrow function. A caller-aware transformation can read identity without returning private context:

```json
{
  "id": "prepare",
  "kind": "transform",
  "language": "javascript",
  "expression": "if (!input.scope.$caller) throw new Error('caller_required'); return { ownerId: input.scope.$caller.principalId, text: input.input.text };"
}
```

Identity checks belong in the workflow header when supported: `required_caller_kind: "user" | "system_account"` requires an authenticated principal of that kind. `product_id` must match `^[a-z][a-z0-9-]*$` and must match the authenticated `productId`; declaring it never grants that identity. A product principal may execute only a matching saved workflow, never an inline draft or standalone step, even for reads or held writes. A generic principal cannot run a product workflow, and a product principal cannot run an untagged workflow. Callerless schedules/webhooks cannot run workflows requiring a caller or product. Do not copy the human approver's identity into a schedule.

For product S3 requests, declare `s3.scope: { key_prefix: "products/<product-id>/", principal_bound: true, max_bytes: <reviewed-limit> }`. Author keys or LIST prefixes under `products/<product-id>/${caller.principalKind}/${caller.principalId}/`; the engine enforces both kind and ID. Same UUID with another principal kind is another owner. Keep the literal reviewed prefix and existing size/delete limits; do not broaden scope to fix a denial. Opaque IDs unsafe as path segments are refused.

Validate the actual definition with the schema and placeholder validator before saving. Ground business input separately from identity: never put a fabricated caller in `input_schema`, `input_schema_sample`, fixtures or request data to make validation pass. For ordinary workflows, use existing authoring/validation tools and a permitted preview; validate the result, warnings and storage boundary before the human effect review. Product execution must use the approved matching saved workflow through the public run API.

## Supabase-backed caller workflows

Treat Supabase as the product backend and SubKit as the workflow runtime. Use the ordinary authoring flow to create a saved workflow; do not add SQL steps or put database credentials in the definition. Configure the Supabase connector with the gateway headers it actually requires. `apikey` is the public project API key; `Authorization` carries the JWT for the intended database role. A tenant-wide connector credential cannot represent separate mobile users; never pass an app user's JWT as workflow input. Use a protected owner-binding RPC that maps immutable `$caller` to the Supabase owner. A protected RPC may also require `x-subkit-token`, stored only as an encrypted connector header. That shared server credential authenticates SubKit to the product backend; it is neither `$caller` nor a user token. Never expose it to the app, workflow input, step headers, context, source, logs, or generated instructions. Never use `service_role` for caller-scoped access. A request step may forward a dynamic `Authorization` value only when tenant-scoped validation confirms the selected connector and its current saved credentials do not own that header; this does not let a workflow override `x-subkit-token` or any other saved credential. A user JWT is a credential, not `$caller`: ordinary workflow inputs are not a safe token channel. Forward a JWT only through a separately verified, short-lived path with sensitive execution privacy; when that path is unavailable, use an owner-binding RPC based on immutable `$caller`.

For a quota-gated provider call, bind the workflow to its product and `required_caller_kind`, use sensitive execution privacy for private prompts/results, and derive tenant, product, principal kind and principal ID exclusively from `$caller`. An app-supplied request ID and request payload may be ordinary validated input, but must not override identity. First call the backend's atomic idempotent reservation RPC. Continue to the model only when its result is exactly `status: "reserved"`; return an existing cached result without another model call, and stop on `busy`, limits, missing fields, or any RPC error. After the provider returns, finalize using the reservation claim and persist the result. Never replace the reservation with a read-only quota check, never fail open, and never claim a successful model call when reservation failed. Verify the exact endpoint schema and result contract from the real connector before authoring, then validate with the normal authoring gates and save inactive. A sensitive workflow uses only the metadata test run or the `schema_only` check in chat, never a value-returning preview; test live only with dedicated synthetic data through an explicitly approved execution path.

Client-supplied context belongs in ordinary input, for example `input.context` with locale, timezone, screen and request ID. Read `$input.context` in JSONata or `input.scope.$input.context` in JavaScript. Declare its nested fields, required properties, types and size limits in `input_schema`; use `additionalProperties: false` where extra fields must be refused. Context is untrusted business data, never a replacement for `$caller`, tenant authorization or object ownership. Do not include credentials. An object ID supplied in context still requires an access check using the authenticated caller.

Runtime schemas use synchronous JSON Schema draft-07 semantics, including nested constraints and local references. Invalid schemas, unresolved references and `$async` are refused. Validation does not coerce values, insert defaults or remove fields. `format` is an annotation, not a validation rule; use explicit `pattern`, `enum` and bounds when those restrictions matter.

Omitted workflow input becomes `{}` when the declared schema has `type: "object"`; required fields still fail validation. Explicit JSON `null` stays null and must satisfy the schema. Existing schedule input is used only when preparation input is omitted, never to replace explicit `{}` or null.

Both can coexist:

```json
{
  "input_schema": {
    "type": "object",
    "required": ["context"],
    "additionalProperties": false,
    "properties": {
      "context": {
        "type": "object",
        "required": ["locale"],
        "additionalProperties": false,
        "properties": { "locale": { "type": "string", "minLength": 2, "maxLength": 16 } }
      }
    }
  },
  "input_schema_sample": {
    "context": { "locale": "de-DE" }
  }
}
```
