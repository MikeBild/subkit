# Security policy

## Supported versions

Only the newest release gets security fixes. A fix ships as the next patch or minor release; older
versions are not patched, so update to the newest release to receive it.

| Version | Supported |
| --- | --- |
| Newest release (see the GitHub releases page) | Yes |
| Every older release | No |

The desktop app follows the server version. Its fixes ship with the same release.

## Report a vulnerability

Do not open a public issue for a vulnerability.

Send the report through the contact form at <https://subkit.mikebild.dev/en/contact/> and start the
subject with “Security”. Include:

- the affected version (`engine --version`, `subkit --version` or the desktop app's About panel),
- what an attacker can do and what they need for it,
- the steps to reproduce it, ideally with a minimal request or workflow,
- whether you have already told anyone else.

You get an answer within five working days. Once the issue is confirmed, you hear when a fix is
planned and when it ships. Credit in the release notes is yours if you want it.

## What the repository checks on every push

Every push to `main` runs CodeQL, Semgrep and gitleaks (`.github/workflows/security.yml`). The
`pre-push` hook runs gitleaks on the pushed commits before they leave your machine, and every
release verifies the image and its software inventory with `bun run release security`.

`bun run verify semgrep` runs the same Semgrep scan on your machine. Accepted findings are kept in
two files, each entry with its reason: `.semgrepignore` for paths and `.semgrep-excluded-rules`
for rules. CodeQL reads `.github/codeql/codeql-config.yml`.
