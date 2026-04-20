---
slug: document-analysis-guidance
scope: global
title: Document Analysis Guidance
description: Guides the LLM when analyzing uploaded API specification files (OpenAPI, Postman, HAR, GraphQL, PDF, image).
gates_tools: []
version: 1
auto_load: true
trigger_keywords: [openapi, swagger, yaml, postman, har, graphql, pdf, image, screenshot, upload, specification, spec, api-doc]
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

## Step 3: Extract integration metadata

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

Only then call `build_workflow` or `propose_step`.
