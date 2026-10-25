---
slug: use-the-sk-cli-on-your-machine
summary: Install the sk CLI from your engine and work with it in the terminal.
section: work
order: 1
audience: public
---
## Use the sk CLI on your machine

Your engine serves the CLI itself. There is no npm package.
You install `sk` once, sign in, and then work with workflows, runs and connectors in the terminal.

### What you need

- The address of your engine, without a path. The examples use `http://localhost:3000`.
  For SubKit Cloud, see "Use SubKit Cloud".
- Bash and curl.
- For an API key on a self-hosted engine: access to the engine host.

### Install and sign in

1. Install the CLI from your engine:

   ```bash
   curl -fsSL http://localhost:3000/install | bash
   ```

2. Sign in:

   ```bash
   sk login --engine-url http://localhost:3000
   ```

   Your browser opens. After you sign in, `sk` prints `sk: signed in as …` and saves the profile.
3. Run `sk` to start. `sk --help` lists every command.

The engine describes itself at `/openapi.json` and `/llms.txt`.

### Sign in with an API key

Use this for scripts, or for a self-hosted engine without an identity provider.

1. On the engine host, issue an admin key. The command prints a ready `sk login` line:

   ```bash
   docker compose exec engine engine --issue-admin-key --tenant my-org
   ```

2. Run the printed line. It has this form:

   ```bash
   sk login --engine-url http://localhost:3000 --api-key <key>
   ```

   `sk` prints `sk: profile 'default' saved` and the engine health.

### Install from a public GitHub release

Use this to install a signed public release instead of the download from your engine.
You need Bash, curl, and OpenSSL with Ed25519 support, for example OpenSSL 3 on your PATH.

1. Check out the published public release and review it.
2. In the checkout, run the installer:

   ```bash
   bash scripts/install.sh
   ```

The script installs the matching CLI for Linux or macOS and creates the local `subkit` compatibility link.
It puts `subkit.LICENSE` and `subkit.THIRD_PARTY_NOTICES.txt` beside the CLI.
The release assets must be publicly downloadable. A local build or a private repository is not sufficient.

### What the installers check

Each installer checks the files before it replaces an existing installation.
Missing license assets, missing signatures or unsupported cryptography stop the installation.

| Installer | What it checks | What it trusts |
| --- | --- | --- |
| `scripts/install.sh` | The signed checksum manifest, then the selected binary and both license assets | The pinned release public key |
| `/install` from the engine | The binary, `LICENSE` and `THIRD_PARTY_NOTICES.txt` from the same engine bundle or an explicit mirror, against that source's checksum manifest | The engine or mirror you selected, not a release signature |
| `sk update` | The signed checksum manifest of the release, then the binary and both license assets. It reads the version and files from the engine of your active profile and falls back to GitHub releases. It keeps the existing notices with their checksums for rollback. | The pinned release public key, whether the files come from your engine or from GitHub |

### Update the CLI

Run `sk update` to install the newest version. `sk update --check` only reports it.
`sk` asks the engine of your active profile first, so a private repository or a missing GitHub token does not block the update. The engine serves the signed release checksums, and `sk` verifies them before it replaces the binary.
Versions before 10.15.1 only ask GitHub. Install once again with `curl -fsSL <engine-url>/install | bash`; later updates then work without a token.

Older retained versions without notice metadata cannot rebuild missing historical license files.
Their rollback still works as before.

### If something does not work

| What you see | What to do |
| --- | --- |
| `sk: browser login failed` | The browser sign-in did not complete. Try again, or follow "Sign in with an API key". |
| `sk login` cannot reach the engine | Check the `--engine-url`. Give the address without a path. |
| `scripts/install.sh` stops with a missing license asset or signature | Use a published public release. A local build or a private repository does not work. |
| `scripts/install.sh` stops because of unsupported cryptography | Put OpenSSL with Ed25519 support, for example OpenSSL 3, on your PATH. |
