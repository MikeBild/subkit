# Contributing

Thanks for helping. This page covers what you need before you open an issue or a pull request.

## Ask, report, propose

- Questions and ideas: [Discussions](https://github.com/MikeBild/subkit/discussions).
- Bugs and concrete features: [Issues](https://github.com/MikeBild/subkit/issues/new/choose), using one of the forms.
- Vulnerabilities: never in public. Follow [SECURITY.md](../SECURITY.md).

Open an issue before you start a larger change, so we can agree on the scope first.

## Set up

You need the Bun version from `.bun-version` and Docker for the database-backed tests.

```sh
bun install --frozen-lockfile
bun run compose up          # the local stack, including PostgreSQL for the integration tests
bun run test unit
```

`bun run <command> help` lists the subcommands of every root command, for example `bun run test help`.

## Rules for a change

- Code, commit messages and pull requests are in English. End-user docs exist in German and English; change both when behavior or setup changes.
- No code comments; tool directives such as `biome-ignore` are the only exception.
- No version, date or ticket names in code, tests or file names.
- Keep tenant isolation, RBAC, audit and encryption intact. Public HTTP and MCP types are Zod-first; the OpenAPI document is generated.
- Every behavior change comes with a test that fails without it. Pick the smallest layer that proves it: `unit`, `integration`, `e2e` or `contract`.
- Commit subjects follow Conventional Commits, one short line, no body, for example `fix(http): keep the status on retry`.

## Before you push

```sh
bun run lint
bun run typecheck
bun run audit
bun run test unit
```

`bun run verify` runs the full local gate. CI runs the security scans on `main`.

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](../LICENSE).
