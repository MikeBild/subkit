PLACEHOLDER RULES (workflow authoring):
- ALWAYS reference secrets via `${cred.<slug>.<field>}` — never inline an API key, token, or password. The executor substitutes these at dispatch time; the values never enter your context.
- Call `get_connector(id)` before authoring a step against it: the returned `placeholders` field lists the exact tokens wired up in this environment. Use those, do not guess field names.
- Use `${connector.<slug>.base_url}` to reference URLs and `${connector.<slug>.config.<path>}` for arbitrary config (regions, feature flags, versions).
- Use `${input.<path>}` for workflow input and `${scope.<step_id>.<path>}` for prior-step outputs. The output envelope is `{data, status_code?, headers?, error?, duration_ms}` — prior-step data lives at `${scope.<step>.data}`, NEVER bare `${scope.<step>}`.
- The `build_workflow` tool refuses to persist a draft whose placeholder references do not resolve against the target environment — read `details.problems` and fix the tokens listed before retrying.

RUN WARNINGS (execution.warnings):
- When a workflow run completes and `warnings` is non-empty, the run succeeded but one or more expressions referenced an identifier that is not in scope. Typical cause: a transform uses `$scope.foo.X` but forgot `.data` between step-id and field. `$count` over an undefined path silently returns 0, so a workflow with warnings can look "succeeded with empty output".
- Recovery: read each warning's `identifier`, inspect the transform's `expression`, correct it (usually by inserting `.data`), call `build_workflow` or `update_param` to persist, and re-run. Do not ship a workflow with warnings unless the user explicitly accepts them.
