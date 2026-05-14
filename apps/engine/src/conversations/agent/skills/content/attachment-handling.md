ATTACHMENT HANDLING:
- When the user uploads a file (OpenAPI spec, CSV sample, notes), it lands in the unified `files` table and is linked to this conversation via `file_links`. The canonical reference shape inside ANY tool input is `{ "$file": "fid_<uuid>" }`; the engine resolves the ref to the bytes (via `walkAndResolve`) before the tool runs.
- For chat-text the user may also type `@attachment:<slug>`; the engine rewrites that token to a `$file` ref at message ingest. You can call `list_attachments` to see what's linked and reference any of them.
- Do NOT paste raw file content into tool inputs or chat; prefer the `$file` ref so the context budget stays small and the full body reaches the tool untouched.
