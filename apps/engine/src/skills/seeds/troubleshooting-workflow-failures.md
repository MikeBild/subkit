---
slug: troubleshooting-workflow-failures
scope: global
title: Execution-Time Workflow Failure Diagnosis
description: Systematic guide for diagnosing failures of workflows that have already been committed and executed — reading `list_executions` / `get_execution`, interpreting schema violations, and reading connector circuit-breaker state. For errors that surface while authoring in a conversation (an authoring action returned `{ok:false}`), see `error-recovery`.
activates_when: [{"kind":"baseline"},{"kind":"intent_keyword","word":"troubleshoot"},{"kind":"intent_keyword","word":"execution failed"},{"kind":"intent_keyword","word":"run failed"},{"kind":"intent_keyword","word":"workflow failed"},{"kind":"intent_keyword","word":"past run"},{"kind":"intent_keyword","word":"get_execution"},{"kind":"intent_keyword","word":"list_executions"},{"kind":"intent_keyword","word":"schema-violation"},{"kind":"intent_keyword","word":"schema_violation"},{"kind":"intent_keyword","word":"input_schema_violation"},{"kind":"intent_keyword","word":"response_schema_violation"},{"kind":"intent_keyword","word":"request_body_schema_violation"},{"kind":"intent_keyword","word":"unexpected_status_code"},{"kind":"intent_keyword","word":"transform_input_schema_violation"},{"kind":"intent_keyword","word":"output_schema_violation"},{"kind":"intent_keyword","word":"circuit-breaker"},{"kind":"intent_keyword","word":"circuit_state"},{"kind":"intent_keyword","word":"circuit open"}]
side_effects: read
idempotency: none
maturity: stable
tags: [diagnosis, execution, failures]
audience: [runtime]
version: 3
---

# Workflow Failure Troubleshooting

Use `list_executions` and `get_execution` to retrieve the failed execution details before explaining the error to the user.

## Error code reference

### `input_schema_violation`
The caller provided wrong or missing fields when triggering the workflow.
→ Show the required `input_schema` to the user. Provide a corrected input example.
→ Check if the schema changed recently (look at workflow version history).

### `response_schema_violation`
The external API returned a response that doesn't match the expected shape.
→ Run `list_executions` to get the actual response body from the failed step.
→ Check `connector_endpoint_schemas` for the stored schema vs. actual response (drift).
→ Suggest updating `response_schema` or running self-healing analysis.

### `request_body_schema_violation`
The request body failed validation before the HTTP call was made.
→ Show the step's `body_schema` and the actual body that was constructed.
→ Check if an upstream transform step changed the data shape unexpectedly.

### `unexpected_status_code`
The API returned an HTTP status not in `expected_statuses`.
→ If 429: check `circuit_failure_count` on the connector. Advise on retry configuration.
→ If 4xx: authentication or authorization issue — check credentials are current.
→ If 5xx: transient API issue — check if circuit breaker opened.

### `transform_input_schema_violation`
A prior step's output changed shape, breaking a downstream transform.
→ Identify which step's `response_schema` no longer matches the transform's `input_schema`.
→ Check the JSONata expression for path references that may have changed.
→ Suggest updating the transform expression or the upstream step's schema.

### `output_schema_violation`
The workflow's final output doesn't match the declared `output_schema`.
→ This is a warning, not a fatal error. The workflow still completed.
→ Check if the last step's data_selector or output mapping needs updating.

## Circuit breaker state

If a connector's `circuit_state` is `open`, all requests to it fail immediately without making HTTP calls. The circuit opens after `circuit_threshold` consecutive failures and resets after `circuit_reset_ms` milliseconds.
→ Use `get_connector` to check the current circuit state.
→ If the underlying API is healthy again, the circuit will move to `half-open` automatically after the reset period.

## Example: failure envelope shape

Failed steps return a typed envelope. The `error_code` is the canonical
machine key — branch on it; the `message` is for the human. `request_meta`
carries driver-level context (status code, byte counts, connector
resolution) when the step actually hit the network.

```json
{
  "step_id": "fetch",
  "kind": "request",
  "status": "failed",
  "duration_ms": 412,
  "error_code": "http_4xx",
  "error": {
    "code": "http_4xx",
    "message": "400 Bad Request",
    "details": {
      "status": 400,
      "body": {
        "error": "property 'closedate' is not searchable; use 'hs_closedate'"
      }
    }
  },
  "request_meta": {
    "method": "GET",
    "status": 400,
    "bytes_in": 187,
    "connector": { "connector_id": "<hubspot_connector_id>", "auth_method": "bearer" }
  }
}
```

Common `error_code` values worth memorising:

- `placeholder_unresolved` — `${scope.…}` / `${cred.…}` did not resolve to a value
- `http_4xx` / `http_5xx` — auth / payload / server errors
- `transform_dropped_fields` (warning, not failure) — projection silently lost fields
- `validation_failed` — workflow-level `validation_expression` returned falsy
- `workflow_cycle_detected` — authoring-time cycle in step references
