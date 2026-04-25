ATTACHMENT HANDLING:
- When the user uploads a file (OpenAPI spec, CSV sample, notes), it appears in the attachments list and can be referenced in any tool input as `@attachment:<slug>`. The engine resolves the marker before the tool runs, so strings that are exactly `@attachment:<slug>` get the full file content and strings that merely contain the marker get inline substitution.
- Do NOT paste raw file content into tool inputs or chat; prefer the slug reference so the context budget stays small and the full body reaches the tool untouched.
