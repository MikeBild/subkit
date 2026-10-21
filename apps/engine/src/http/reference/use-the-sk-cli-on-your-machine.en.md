---
slug: use-the-sk-cli-on-your-machine
summary: Install the sk CLI from your engine and work with it in the terminal.
section: work
order: 1
audience: public
---
## Use the sk CLI on your machine

The engine serves the CLI itself. There is no npm package.

```bash
curl -fsSL http://localhost:3000/install | bash
docker compose exec engine engine --issue-admin-key --tenant my-org   # prints an `sk login` line
sk login --engine-url http://localhost:3000 --api-key <key>
sk
```

`sk --help` lists every command. The engine describes itself at `/openapi.json` and `/llms.txt`.

For a published public GitHub release, `bash scripts/install.sh` from a reviewed
checkout installs the matching CLI for Linux or macOS and creates the local
`subkit` compatibility link. It requires Bash, curl, and OpenSSL with Ed25519 support
(for example OpenSSL 3 on your PATH). It verifies the signed checksum manifest
against the pinned release public key, then verifies the selected binary and both
license assets before replacing an existing installation. It installs `subkit.LICENSE`
and `subkit.THIRD_PARTY_NOTICES.txt` beside the CLI. Missing license assets, missing signatures or unsupported cryptography
stop installation. This path requires publicly downloadable release assets; a local
build or a private repository is not sufficient. The engine-served installer above
is a separate download path from your own installation. It requires the binary,
`LICENSE`, and `THIRD_PARTY_NOTICES.txt` from the same engine bundle or explicit
mirror and verifies each against that source's checksum manifest. Its trust boundary
is your selected engine/mirror; it does not imply GitHub release-signature verification.

The GitHub updater also requires both signed license assets. It updates the notices
beside the binary and retains existing notices with their checksums for rollback.
Older retained versions without notice metadata cannot reconstruct missing historical
license files; their existing rollback behavior remains available.

