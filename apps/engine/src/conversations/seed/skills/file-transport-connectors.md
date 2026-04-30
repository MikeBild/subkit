---
slug: file-transport-connectors
scope: global
title: FTP / SFTP / SMB Connectors
description: Driver specifics for file-transport drivers — list / get / put / delete operations against FTP, SFTP, and SMB shares.
gates_tools: []
version: 1
---

# FTP / SFTP / SMB Connectors

Three drivers expose the same operation surface (`LIST` / `GET` / `PUT` /
`DELETE` / `RENAME` / `MKDIR` / `RMDIR` / `EXISTS` / `STAT`) across
different protocols. Pick the one that matches the upstream:

| Driver | Protocol | Library | Auth |
|---|---|---|---|
| `ftp` | FTP, FTPS | `basic-ftp` | `user:password` in DSN |
| `sftp` | SFTP (SSH) | `ssh2-sftp-client` | password OR private key |
| `smb` | SMB / CIFS (Windows shares) | `@awo00/smb2` | NT user + password + domain |

## DSN

```
# FTP / FTPS
ftps://${cred.archive.user}:${cred.archive.password}@${connector.archive.config.host}:990

# SFTP — password
sftp://${cred.feeds.user}:${cred.feeds.password}@${connector.feeds.config.host}:22

# SFTP — private key (key bytes go in cred.feeds.private_key)
sftp://${cred.feeds.user}@${connector.feeds.config.host}:22

# SMB / Windows share — DOMAIN\\user
smb://DOMAIN%5C${cred.share.user}:${cred.share.password}@fileserver/share
```

The `%5C` is URL-encoded `\` for the SMB domain separator.

## Step shape

Use the `file` block on a `request` step. `op` decides which fields are
required:

```json
{
  "id": "list_inbound",
  "kind": "request",
  "connector_id": "<feeds_connector>",
  "file": { "op": "LIST", "path": "/incoming/" }
}
```

```json
{
  "id": "fetch_csv",
  "kind": "request",
  "connector_id": "<feeds_connector>",
  "file": { "op": "GET", "path": "${scope.list_inbound.data[0].name}" }
}
```

```json
{
  "id": "deliver",
  "kind": "request",
  "connector_id": "<feeds_connector>",
  "file": {
    "op": "PUT",
    "path": "/outgoing/report.csv",
    "content": "${scope.render_csv.data}",
    "encoding": "utf8"
  }
}
```

`LIST` returns an array of `{ name, type, size, modified_at }`. `GET`
returns binary as a base64-encoded `data` (set `encoding: "base64"` on
the step to opt in to text decoding).

## Common pitfalls

- **Trailing slash semantics.** `LIST /foo` and `LIST /foo/` are
  identical for FTP/SFTP but SMB requires the trailing slash on
  directories — keep it.
- **Connection re-use.** Each step opens a fresh connection. For large
  batches consider a single step that does the whole job in JS via
  `transform`, not many file steps in a loop.
- **FTPS vs SFTP.** Different protocols. FTPS is FTP + TLS; SFTP is SSH
  file transfer. The hostnames look similar — confirm with the operator.
- **SMB on macOS / Linux clients.** Some upstreams require `?signing=on`
  in the DSN. The driver passes it through as a connection option.

## See also

- `s3-connectors.md` — when the upstream offers S3 alongside FTP, prefer
  S3 for any file ≥ 1 MB or any pipeline that needs presigned URLs.
