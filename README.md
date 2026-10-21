# SubKit

Workflow engine, Cockpit and sk CLI with governed connector execution.

## Develop

Use the Bun version in `.bun-version` and the locked dependencies.

```sh
bun install --frozen-lockfile
bun run start:local
bun run apps/sk/src/index.ts --help
```

## Check

```sh
bun run lint
bun run typecheck
node scripts/check-github-sources.mjs
bun run verify
```

Run focused tests while iterating. Release, deployment and human acceptance are separate gates.

## Technical references

- [Setup and operating contract](apps/engine/src/http/reference)
- [Agent rules](AGENTS.md)
- API, CLI, settings and LLM references are generated from code and the technical setup source.
- `bun run gen:llms-txt` updates the shipped LLM references.
- [License](LICENSE)

## Work and documentation

- [Issues](https://github.com/MikeBild/subkit/issues): tasks, priority and acceptance.
- [SubKit Product](https://github.com/users/MikeBild/projects/4): roadmap, website and launch.
- [Milestones](https://github.com/MikeBild/subkit/milestones): goals and progress.
- [Wiki](https://github.com/MikeBild/subkit/wiki): concepts, decisions and dated evidence.

Keep project management in GitHub. Write short, direct, goal-oriented Issues and Wiki pages.
