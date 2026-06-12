---
slug: document-analysis-guidance
scope: global
title: Document Analysis Guidance
description: Guides the LLM when analyzing uploaded API specification files (OpenAPI, Postman, HAR, GraphQL, PDF, image).
activates_when: [{"kind":"baseline"},{"kind":"intent_keyword","word":"openapi"},{"kind":"intent_keyword","word":"swagger"},{"kind":"intent_keyword","word":"yaml"},{"kind":"intent_keyword","word":"postman"},{"kind":"intent_keyword","word":"har"},{"kind":"intent_keyword","word":"graphql"},{"kind":"intent_keyword","word":"pdf"},{"kind":"intent_keyword","word":"image"},{"kind":"intent_keyword","word":"screenshot"},{"kind":"intent_keyword","word":"upload"},{"kind":"intent_keyword","word":"specification"},{"kind":"intent_keyword","word":"spec"},{"kind":"intent_keyword","word":"api-doc"}]
side_effects: read
idempotency: none
maturity: stable
tags: [discovery, openapi, attachments]
version: 3
---

# Document Analysis Guidance

When a user uploads an API specification file, follow this structured process before generating any workflow steps.

## Step 1: Identify and confirm the document type

State what format was detected (OpenAPI, Postman Collection, HAR, GraphQL SDL, PDF, image) and the confidence score. For AI-extracted documents (PDF, image, markdown) show the confidence:
- ≥ 90%: proceed with extraction
- 70–89%: proceed but flag uncertain fields
- < 70%: ask the user to verify the extracted endpoints before continuing

## Step 2: Summarise detected endpoints before generating steps

Always list extracted endpoints first. Show: method, path, description (if available). Do NOT generate workflow steps until the user confirms which endpoints are relevant to their goal.

Example format:
```
Found 8 endpoints:
  GET  /v1/customers       List customers
  POST /v1/customers       Create customer
  GET  /v1/customers/{id}  Get customer by ID
  ...
Which endpoints should the workflow use?
```

## Step 3: Extract connector metadata

Before generating steps, identify:
- **Authentication**: type (API key, Bearer, OAuth2, Basic), header/parameter name
- **Pagination**: strategy (offset, cursor, page), relevant parameters
- **Rate limits**: X-RateLimit-*, Retry-After header behaviour
- **Error codes**: which status codes are documented

State these explicitly. They inform connector config (`auth_type`, `max_retries`) and step schemas (`expected_statuses`).

## Step 4: Confirm before generating

Do NOT generate workflow steps until the user confirms:
1. Which endpoints are in scope
2. The overall goal (what should happen when the workflow runs)

Only then call `author_workflow` (one call, pass the goal verbatim plus the connector ids — the engine generates and evaluates the complete draft), or `build_workflow` when you already hold the exact definition.

## Example: extracted endpoint summary

A structured summary of what the assistant pulled from the uploaded
document, ready to surface back to the user before any workflow step is
generated. Keep this format consistent so the user can quickly point at
which endpoints to wire into the workflow.

```json
{
  "format": "openapi",
  "confidence": 0.94,
  "auth": {
    "type": "bearer",
    "header": "Authorization",
    "scheme": "Bearer"
  },
  "pagination": {
    "strategy": "cursor",
    "cursor_request_param": "starting_after",
    "cursor_response_path": "data[last].id"
  },
  "endpoints": [
    {
      "method": "GET",
      "path": "/v1/customers",
      "description": "List customers (paginated)",
      "expected_statuses": [200]
    },
    {
      "method": "POST",
      "path": "/v1/customers",
      "description": "Create a customer",
      "expected_statuses": [200, 201]
    },
    {
      "method": "GET",
      "path": "/v1/customers/{id}",
      "description": "Get a customer by id",
      "expected_statuses": [200, 404]
    }
  ]
}
```

After the user picks the endpoints to wire, translate each one to a
`request` step with `method`, `connector_id`, and `path` fields directly
on the step (not nested under a `config` wrapper).
