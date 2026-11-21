---
slug: use-the-sk-cli-on-your-machine
summary: Get the sk CLI from your engine and work in the terminal.
section: work
order: 1
audience: public
---
## Use the sk CLI on your machine

This chapter is for anyone who prefers the terminal or scripts to the Cockpit.
You install the `sk` command line, sign in and keep it up to date.
Afterwards you write workflows, connectors and knowledge as files and start runs from the terminal.

You get the `sk` command line straight from your engine. With it you draft, change and run workflows as files; `sk agent init` adds SubKit to Claude Code and Codex.
There is no npm package.

### What you need

- The address of your engine, without a path. The examples use `http://localhost:3000`.
  For SubKit Cloud, see "Use SubKit Cloud".
- Bash and curl.
- To sign in with an API key on a self-hosted engine: access to the engine host.

### Install and sign in

1. Install the CLI from your engine:

   ```bash
   curl -fsSL http://localhost:3000/install | bash
   ```

2. Sign in:

   ```bash
   sk login --engine-url http://localhost:3000
   ```

   Your browser opens. After you sign in, `sk` prints `sk: signed in as …` and saves the connection as a profile.
3. Run `sk`. Without a command it opens an interactive session; `sk --help` lists every command.

The engine also describes itself: the HTTP API at `/openapi.json`, the documentation for AI clients at `/llms.txt`.

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

   `sk` replies with `sk: profile 'default' saved` and the engine health.

### Work with several engines

A profile is a saved sign-in to one engine. It lets you work with a test and a production engine, or with several workspaces, without signing in again.
Profiles live in `~/.sk/config.json`.

| Command | What it does |
| --- | --- |
| `sk login --engine-url <address> --profile <name>` | Adds another profile. |
| `sk profile list` | Shows all profiles. |
| `sk profile use <name>` | Switches the active profile. |
| `sk status` | Shows the active profile and whether the engine is reachable. |
| `sk profile delete <name>` | Deletes a profile. |

For a single command, add `--profile <name>` without switching the active profile.

### Update the CLI

`sk update` installs the newest version, `sk update --check` only reports it.
`sk` fetches the version from the engine of your active profile first and only then from the public releases. You need no GitHub access for this.
Before replacing anything, `sk` verifies the signed checksums. If a file does not match, your current installation stays as it is.

The previous version is kept. `sk update --rollback` restores it.

### What the installers check

Each installer checks the files before it replaces an existing installation.
Missing license files, missing signatures or unsupported cryptography stop the installation.

| Installer | What it checks | What it trusts |
| --- | --- | --- |
| `/install` from the engine | The binary, `LICENSE` and `THIRD_PARTY_NOTICES.txt` against the checksum manifest of the engine or of an explicitly chosen mirror | The engine or mirror you chose, not a release signature |
| `sk update` | The signed checksum manifest of the release, then the binary and both license files | The pinned public release key, whether the files come from your engine or from GitHub |
| `scripts/install.sh` | The signed checksum manifest, then the binary and both license files | The pinned public release key |

### Install from a public release

Instead of your engine, you can also install `sk` from a signed public release.
The public beta is in preparation. Packages and the guide follow once released.

Once a release is published, check it out, review it and run `bash scripts/install.sh` in the checkout.
For this you also need OpenSSL with Ed25519 support on your PATH, for example OpenSSL 3.
The script installs the matching CLI for Linux or macOS and puts `subkit.LICENSE` and `subkit.THIRD_PARTY_NOTICES.txt` next to it.
A local build or a private repository is not enough.

### Move your workspace to another engine

A package carries your own workflows, connectors, connector templates, skills, schedules, sources and their files to another engine.
Credentials, approvals, roles, categories, settings and the history stay behind.
To copy a whole self-hosted installation, make a backup instead, as described in "Run the engine".

You need `package:export` on the source engine and `package:import` on the target engine. Members and administrators have both.
After the import, someone with `vault:write`, usually an administrator, adds the credentials. A member can complete an OAuth sign-in.

1. Sign in to both engines, each with its own profile:

   ```bash
   sk login --engine-url https://<engine-a> --profile a
   sk login --engine-url https://<engine-b> --profile b
   ```

2. Export from engine A:

   ```bash
   sk packages export --out workspace.zip --profile a
   ```

   `--category <categories>` exports one area only, for example `--category devops,cloud`. Whatever the area needs comes along: connectors, connector templates, sub-workflows and schedules.
   `--only <kinds>` exports only some kinds. `--json` prints the result as JSON.
3. Import into engine B:

   ```bash
   sk packages import workspace.zip --profile b
   ```

   `sk` first shows the plan: each item is `create`, `update`, `unchanged` or `conflict`. Confirm it, or pass `--yes`.
   If engine B changed after the plan, the import stops and changes nothing. Then run it again.
4. Finish on engine B. Nothing runs or writes until you do:
   - Enter the credentials of each connector. The package contains none.
   - Activate the skills. They arrive as drafts.
   - Confirm the knowledge in the Cockpit review. It arrives as a proposal and is never admitted automatically.
   - Review the workflows and grant their approvals. They arrive as inactive drafts.
   - Resume the schedules. They arrive paused.
   - Start a test run.

Importing the same package again shows every item as `unchanged`.
An item you changed on engine B shows as `conflict` and is never overwritten.
`sk packages installs` lists past imports.

In the Cockpit you find the same in the "…" menu of workflows, connectors, skills, sources and files: "Export as package…" and "Import package…". If a category is filtered, the export already selects it.
In the chat, attach a package of up to 5 MB and ask to import it. The chat shows the plan and asks before importing, unless the conversation runs without confirmations. Import larger packages of up to 256 MB through the menu.

You can move area by area: one package per category, each with its preview, setup and test run.
A connector that an earlier package already brought stays `unchanged`, even after you stored its credentials on engine B.

### If something does not work

| What you see | What to do |
| --- | --- |
| `sk: browser login failed` | The browser sign-in did not complete. Try again, or follow "Sign in with an API key". |
| `sk login` cannot reach the engine | Check the `--engine-url`. Give the address without a path. |
| A command lands on the wrong engine | Check the active profile with `sk status` and switch with `sk profile use <name>`. |
| `sk update` only asks GitHub or wants a GitHub token | Your CLI predates updating through the engine. Reinstall it once as in "Install and sign in". Updates then run through your engine. |
| `scripts/install.sh` stops with a missing license file or signature | Use a published public release. A local build or a private repository does not work. |
| `scripts/install.sh` stops because of unsupported cryptography | Put OpenSSL with Ed25519 support, for example OpenSSL 3, on your PATH. |
