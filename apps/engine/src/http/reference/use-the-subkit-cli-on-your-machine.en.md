---
slug: use-the-subkit-cli-on-your-machine
summary: Get the subkit CLI from your engine and work in the terminal.
section: work
order: 1
audience: public
---
## Use the subkit CLI on your machine

This chapter is for anyone who prefers the terminal or scripts to the Cockpit.
You install the `subkit` command line, sign in and keep it up to date.
Afterwards you write workflows, connectors and knowledge as files and start runs from the terminal.

You get the `subkit` command line from the latest release or straight from your engine. With it you draft, change and run workflows as files; `subkit agent init` adds SubKit to Claude Code and Codex.
There is no npm package. Builds exist for macOS on Apple silicon, Linux (x64 and arm64) and Windows (x64).

### What you need

- The address of your engine, without a path. The examples use `http://localhost:3000`.
  For SubKit Cloud, see "Use SubKit Cloud".
- On macOS and Linux: Bash and curl. On Windows: PowerShell 7.
- To sign in with an API key on a self-hosted engine: access to the engine host.

### Install and sign in

1. Install the CLI from your engine:

   ```bash
   curl -fsSL http://localhost:3000/install | bash
   ```

   The engine hands out the installer with its own version pinned, so the CLI matches your engine.
   Without an engine at hand, install the latest release instead:

   ```bash
   curl -fsSL https://github.com/MikeBild/subkit/releases/latest/download/install.sh | bash
   ```

   Both put `subkit` into `~/.local/bin`. Set `SUBKIT_INSTALL_DIR` to choose another folder, or `SUBKIT_VERSION` to pin a version.

   On Windows, run this in PowerShell 7 as yourself, not as administrator:

   ```powershell
   irm http://localhost:3000/install.ps1 | iex
   ```

   Without an engine at hand, use the latest release:

   ```powershell
   irm https://github.com/MikeBild/subkit/releases/latest/download/install.ps1 | iex
   ```

   It puts `subkit.exe` into `%LOCALAPPDATA%\Programs\subkit` and adds that folder to your user `PATH`. Open a new terminal afterwards.

2. Sign in:

   ```bash
   subkit login --engine-url http://localhost:3000
   ```

   Your browser opens. After you sign in, `subkit` prints `subkit: signed in as …` and saves the connection as a profile.
3. Run `subkit`. Without a command it opens an interactive session; `subkit --help` lists every command.

The engine also describes itself: the HTTP API at `/openapi.json`, the documentation for AI clients at `/llms.txt`.

### Sign in with an API key

Use this for scripts, or for a self-hosted engine without an identity provider.

1. On the engine host, issue an admin key. The command prints a ready `subkit login` line:

   ```bash
   docker compose exec engine engine --issue-admin-key --tenant my-org
   ```

2. Run the printed line. It has this form:

   ```bash
   subkit login --engine-url http://localhost:3000 --api-key <key>
   ```

   `subkit` replies with `subkit: profile 'default' saved` and the engine health.

### Work with several engines

A profile is a saved sign-in to one engine. It lets you work with a test and a production engine, or with several workspaces, without signing in again.
Profiles live in `~/.subkit/config.json`.

| Command | What it does |
| --- | --- |
| `subkit login --engine-url <address> --profile <name>` | Adds another profile. |
| `subkit profile list` | Shows all profiles. |
| `subkit profile use <name>` | Switches the active profile. |
| `subkit status` | Shows the active profile and whether the engine is reachable. |
| `subkit profile delete <name>` | Deletes a profile. |

For a single command, add `--profile <name>` without switching the active profile.

### Update the CLI

`subkit update` installs the latest release, `subkit update --check` only reports it.
`subkit update --match-engine` installs the version your active profile's engine runs, from the engine itself when it bundles the CLI.
Before replacing anything, `subkit` verifies the signed checksums. If a file does not match, your current installation stays as it is.
The previous version is kept. `subkit update --rollback` restores it.

Once a day, `subkit` checks in the background whether a newer release exists and then prints one line after the command. It never updates on its own.
To switch the check off, put `"updateCheck": false` into `~/.subkit/settings.json`.

When `subkit` talks to an engine of another minor or major version, it prints a warning with the command that aligns both.

### What the installers check

Each installer checks the files before it replaces an existing installation.
A missing license file or a checksum that does not match stops the installation.

| Installer | What it checks | What it trusts |
| --- | --- | --- |
| `install.sh` from the release or the engine's `/install` | The binary, `LICENSE` and `THIRD_PARTY_NOTICES.txt` against `SHA256SUMS`, and the signature of `SHA256SUMS` when it is published and OpenSSL 3 is on your PATH | The release or engine you download from, and the pinned public release key when it can check the signature |
| `install.ps1` from the release or the engine's `/install.ps1` | The binary, `LICENSE` and `THIRD_PARTY_NOTICES.txt` against `SHA256SUMS`; PowerShell cannot check the signature | The release or engine you download from |
| `subkit update` | The signed checksum manifest of the release, then the binary and both license files | The pinned public release key, whether the files come from your engine or from GitHub |

### Dictate a message

In the interactive session, press `Ctrl-D`, speak, and press `Ctrl-D` again. The text lands in the input at the cursor, so you can check and change it before you send it. `Esc` discards the recording.

Dictation needs a recorder on your machine: SoX (`rec` or `sox`) or ffmpeg, on Linux also `arecord`. `subkit doctor` shows which one it found. On Windows with ffmpeg, set `SUBKIT_MICROPHONE` to the name of your microphone. `SUBKIT_DICTATION_LANGUAGE` sets the spoken language, for example `de`; otherwise your system language is used.

### Move your workspace to another engine

A package carries your own workflows, connectors, connector templates, skills, schedules, sources and their files to another engine.
Credentials, approvals, roles, categories, settings and the history stay behind.
To copy a whole self-hosted installation, make a backup instead, as described in "Run the engine".

You need `package:export` on the source engine and `package:import` on the target engine. Members and administrators have both.
After the import, someone with `vault:write`, usually an administrator, adds the credentials. A member can complete an OAuth sign-in.

1. Sign in to both engines, each with its own profile:

   ```bash
   subkit login --engine-url https://<engine-a> --profile a
   subkit login --engine-url https://<engine-b> --profile b
   ```

2. Export from engine A:

   ```bash
   subkit packages export --out workspace.zip --profile a
   ```

   `--category <categories>` exports one area only, for example `--category devops,cloud`. Whatever the area needs comes along: connectors, connector templates, sub-workflows and schedules.
   `--only <kinds>` exports only some kinds. `--json` prints the result as JSON.
3. Import into engine B:

   ```bash
   subkit packages import workspace.zip --profile b
   ```

   `subkit` first shows the plan: each item is `create`, `update`, `unchanged` or `conflict`. Confirm it, or pass `--yes`.
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
`subkit packages installs` lists past imports.

In the Cockpit you find the same in the "…" menu of workflows, connectors, skills, sources and files: "Export as package…" and "Import package…". If a category is filtered, the export already selects it.
In the chat, attach a package of up to 5 MB and ask to import it. The chat shows the plan and asks before importing, unless the conversation runs without confirmations. Import larger packages of up to 256 MB through the menu.

You can move area by area: one package per category, each with its preview, setup and test run.
A connector that an earlier package already brought stays `unchanged`, even after you stored its credentials on engine B.

### If something does not work

| What you see | What to do |
| --- | --- |
| `subkit: browser login failed` | The browser sign-in did not complete. Try again, or follow "Sign in with an API key". |
| `subkit login` cannot reach the engine | Check the `--engine-url`. Give the address without a path. |
| A command lands on the wrong engine | Check the active profile with `subkit status` and switch with `subkit profile use <name>`. |
| `subkit update` cannot find a release | Check your connection to github.com, or align with your engine through `subkit update --match-engine`. |
| The installer reports `signature: skipped` | Your OpenSSL cannot check Ed25519. The checksums were verified; put OpenSSL 3 on your PATH to check the signature as well. |
| A warning says the CLI is older or newer than the engine | Run `subkit update --match-engine`, or update the engine. |
