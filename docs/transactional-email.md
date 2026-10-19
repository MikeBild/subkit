# Transactional email handoff

The canonical technical contract, authoring guidance and operator runbook live in
[README — Transactional email replies](../README.md#transactional-email-replies).
The served LLM page is generated from that section; OpenAPI is generated from the
runtime schemas. This file records delivery status rather than another contract.

## Local implementation

LOCAL_ONLY: general Gmail transactional profiles, signed source provenance,
reviewed input paths, runtime MIME verification, durable reservations and
privacy-preserving receipt inspection are implemented. Provider-compatible tool
palettes cover engine conversations, standalone model tools and MCP workflow
aliases. Fixed-recipient reports retain their existing boundary.

Workflow-authoring guidance, webhook knowledge, generated model documentation,
OpenAPI clients and the installed agent-skill reference set are updated.
Targeted integration, authority, MCP, seed, model-contract and documentation tests
pass. The complete repository quality gate and production rollout remain separate.

## Remaining release work

Complete the full repository gate, integrate a release, deploy the migration and
new engine, then prepare the existing workflow against its real signed binding.
A person reviews the exact changed effect boundary. The operator provisions the
server secret securely. Verify one controlled real delivery and duplicate
suppression before connecting and publishing a public form. Test transports are
not evidence of real Gmail delivery.
