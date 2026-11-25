---
slug: reference-file-servers-and-model-steps
title: Reference: SFTP connectors, model steps and reading files
summary: Look up how a workflow reaches an SFTP server, asks a model for a checked answer and reads CSV, Excel, PDF, Word or ZIP files.
section: reference
order: 11
audience: public
---
## Reference: SFTP connectors, model steps and reading files

This page describes three building blocks for workflows: a connector to an SFTP file server, a step that asks an AI model for an answer in a fixed shape, and a step that reads the content of a file.
It is for people who write or review workflow definitions. The complete, machine-readable description of every field is at `/openapi.json` on your engine.

### SFTP connector

An SFTP connector connects SubKit to one folder on a file server.

- **Address:** `sftp://host:22/folder`. The port is optional and defaults to 22. The address holds only host, port and folder; the username and password never go into it.
- **Host key:** `config.host_key_sha256` holds the SHA256 fingerprint of the server's host key, for example from `ssh-keyscan host | ssh-keygen -lf -`. Without it SubKit refuses every call with `sftp_host_key_missing`. If the server presents another key, the call stops with `sftp_host_key_mismatch` before anything is sent.
- **Sign-in:** either a username and password stored as the connector's credential (`auth_type: "basic"`), or an SSH private key from the vault (`auth_type: "none"` and `config.auth`, see below).
- **Folder:** every path a workflow uses stays inside the folder from the address. A path that leads outside is refused with `sftp_path_outside_root`.
- **Network:** the connection goes through the same egress rules as every other connector, so private addresses stay blocked unless your operator allows them.

Testing the connector lists the folder with one entry. That confirms the address, the host key and the sign-in.

### Signing in with an SSH key from the vault

The private key stays in the vault. The connector holds only the names of the vault items, never the key itself.

1. Store the key as a workspace secret in the vault, in the connector's environment, for example `subkit vault add sftp-deploy-key --env prod < deploy_key`. Supported formats are OpenSSH, RSA PEM, EC PEM and PKCS#8, also encrypted. subkit turns a PKCS#8 key into a format the SSH client reads, in memory only. Supported key types are Ed25519, RSA and ECDSA on P-256, P-384 or P-521.
2. If the key is encrypted, store its passphrase as a second secret, for example `sftp-deploy-key-passphrase`.
3. Set `auth_type: "none"` on the connector and reference the items in `config.auth`:

```json
{
  "host_key_sha256": "SHA256:…",
  "auth": {
    "method": "private_key",
    "username": "deploy",
    "private_key_item": "sftp-deploy-key",
    "passphrase_item": "sftp-deploy-key-passphrase"
  }
}
```

SubKit reads the key from the vault of your workspace only when it connects, after the host key check. Each use is recorded in the vault item's activity without the key. A connector in another workspace can't use your items, even with the same name.

### SFTP steps

A request step with `protocol: "sftp"` works on one path below the connector's folder.

```json
{
  "id": "list_inbox",
  "kind": "request",
  "protocol": "sftp",
  "connector_id": "<connector id>",
  "method": "LIST",
  "sftp": { "path": "inbox/", "max_entries": 500 }
}
```

| Method | Does | Output |
| --- | --- | --- |
| `LIST` | Reads a folder. | `entries` with name, path, type, size and modification time, sorted by name; `truncated: true` when `max_entries` cut the list. |
| `GET` | Downloads one file. | A run file you hand to later steps, for example to a parse-file step. |
| `PUT` | Uploads the step's body as one file. | The written path and the number of bytes. |
| `DELETE` | Removes one file. | The removed path. Folders are never removed (`sftp_delete_not_a_file`), and a `DELETE` with a body is refused. |

- `sftp.path` is the only way to address a file. `url` and `path` on the step are refused.
- `PUT` and `DELETE` are writes: they need the same approval as every other write and are held in a preview.
- Placeholders such as `${input.folder}` are filled in before the call.

### Model step

A step with `kind: "model"` asks the AI model configured for your workspace one question and checks the answer against a JSON Schema.

```json
{
  "id": "classify",
  "kind": "model",
  "prompt": "Sort this support message into one category.",
  "input": "${scope.fetch_message.data.body}",
  "output_schema": {
    "type": "object",
    "properties": { "category": { "enum": ["billing", "shipping", "other"] } },
    "required": ["category"]
  },
  "max_output_tokens": 200
}
```

| Field | Meaning |
| --- | --- |
| `prompt` | The instruction. Placeholders are filled in before the call; each filled-in value is framed as untrusted data. |
| `system` | Optional system prompt. It is added after the workflow step guard, which always stays in place. |
| `input` | Data handed to the model next to the prompt, always as data and never as instructions. |
| `output_schema` | JSON Schema the answer must match. |
| `max_output_tokens` | Upper bound for the answer, at most 32,000. Default 1,024. |

- The step's output is the parsed answer. If the answer is no valid JSON or does not match the schema, the step fails with `model_output_invalid`. `model_output_schema_invalid` means the `output_schema` itself is not a usable JSON Schema; saving the workflow already refuses such a schema.
- A model step uses only `input`, `scope`, `item`, `state` and `caller` values. Credentials, secrets and connector settings are refused when you save the workflow and, at run time, with `model_step_secret_placeholder`, because they would reach the model provider.
- Each call counts against your workspace's AI budget. When the monthly limit is reached, the step does not run and the run says so.
- The approval review lists each model step as an AI model effect: it sends step data to the workspace AI model, names the data paths it sends, the output token cap per call, and whether it runs once per item. A new version that adds a model step, raises its `max_output_tokens`, runs it per item or sends new data paths needs a new approval. A change to the prompt wording alone keeps the existing approval.

### Read files with parse-file

A transform step with `language: "parse-file"` reads a file from the run and returns its content as data.

```json
{
  "id": "read_invoice",
  "kind": "transform",
  "language": "parse-file",
  "file": { "source": "download.data", "format": "xlsx", "sheet": "Items", "max_rows": 2000 }
}
```

| Field | Meaning |
| --- | --- |
| `source` | Where the file sits in the run, as a dot path: an earlier step's output such as `download.data` or a run input such as `$input.invoice`. Saving checks that the path starts with `$input`, `$state`, `$item` (the item of a `for_each` loop) or the id of another step. |
| `format` | `csv`, `xlsx`, `pdf`, `docx` or `zip`. Without it the type is read from the file itself. |
| `sheet` | Spreadsheet sheet to read. Without it the first sheet is read. |
| `max_rows` | Upper bound for table rows from a CSV or spreadsheet file, at most 10,000. |
| `delimiter` | Field delimiter of a CSV file: `","`, `";"`, `"\t"` (tab) or `"\|"`. Without it the delimiter is detected. Saving refuses it next to a `format` other than `csv`; with a detected format, a spreadsheet ignores it. |

| Format | Output |
| --- | --- |
| `csv` | `rows`, `row_count` and `truncated` |
| `xlsx` | `sheet` (the sheet that was read), `sheets` (the names of all sheets), `rows`, `row_count` and `truncated` |
| `pdf` | `text` and `pages` |
| `docx` | `text`, the document as Markdown |
| `zip` | `text`, `entries` and `skipped` for files it could not read |

Every output also carries `format` and `filename`.

Table formats return at most `max_rows` rows, 10,000 if you leave it out. `row_count` is the number of data rows that were read and `truncated` is `true` when rows were left out.

- **CSV:** the first line is the header, and each row is an object keyed by it with string values. Empty lines are skipped and a byte order mark is ignored. Without `delimiter` the delimiter is detected from the first lines: comma, semicolon, tab or pipe; if none fits, a comma is used. Name it with `delimiter` when detection guesses wrong, for example when a column holds commas but the file is split at semicolons. A file that is not valid UTF-8 is read as Windows-1252, so a German Excel export with semicolons and umlauts comes out with proper columns. The whole file is read, so `row_count` counts every row, also past `max_rows`. An unclosed quote or a row with too few or too many fields fails the step with `parse_file_failed` and names the first broken row.
- **XLSX:** only the chosen sheet is read, up to `max_rows` rows. `row_count` comes from the sheet's used range, so for a longer sheet it is the full length even though only `max_rows` rows are returned.

A file may be at most 25 MB. The step does not accept an `expression`; everything is configured in the `file` block.

### Error codes

| Code | Meaning |
| --- | --- |
| `sftp_address_invalid` | The connector address is not `sftp://host[:port]/folder`. |
| `sftp_host_key_missing` | The connector has no host key fingerprint. |
| `sftp_host_key_mismatch` | The server presented a different host key. |
| `sftp_path_outside_root` | The path leads outside the connector's folder. |
| `sftp_key_item_missing` | The vault has no workspace secret with that name in the connector's environment. |
| `sftp_key_not_private_key` | The vault item doesn't hold an SSH private key. |
| `sftp_key_format_unsupported` | The key type or format can't sign in, for example DSA or X25519; store an Ed25519, RSA or ECDSA key as OpenSSH, PEM or PKCS#8. |
| `sftp_key_passphrase_required` | The key is encrypted and `passphrase_item` is missing. |
| `sftp_key_passphrase_wrong` | The passphrase doesn't open the key. |
| `sftp_key_rejected` | The server refused the key for that username. |
| `model_output_invalid` | The model's answer is no valid JSON or does not match `output_schema`. |
| `model_output_schema_invalid` | `output_schema` is not a usable JSON Schema. |
| `model_step_secret_placeholder` | The model step uses a credential, secret or connector setting. |
| `parse_file_source_missing` | No file was found at `source`. |
| `parse_file_unsupported_format` | The file type is not one of the five formats. |
| `parse_file_sheet_missing` | The spreadsheet has no sheet with that name. |
| `parse_file_too_large` | The file is larger than 25 MB. |
| `parse_file_failed` | The file could not be read, or the CSV file is malformed. |
