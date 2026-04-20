---
slug: troubleshooting-workflow-failures
scope: global
title: Workflow Failure Troubleshooting
description: Systematic guide for diagnosing and resolving workflow execution failures.
gates_tools: []
version: 1
auto_load: true
trigger_keywords: [troubleshoot, failure, error, failed, broken, debug, fix, schema-violation, circuit-breaker]
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
