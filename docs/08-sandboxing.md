# 08 — Sandboxing

The engine runs untrusted or semi-trusted code in five tiers, each with its own isolation strength, resource caps, and operational cost. The right tier is chosen per Step kind and per custom tool unit; the engine never escalates a Step into a stricter tier silently, and it never relaxes a stricter tier into a weaker one.

## The five tiers

| Tier | Used for | Configuration | Resource caps |
|---|---|---|---|
| **In-process — request driver** | `request` Steps. Outbound HTTP / Postgres / S3 / GraphQL via the engine's own drivers. | Scoped Credential injection per call, Before-Request Hook gating, response filters, data selectors. | Per-Step timeout (default 1 h), pagination cap (1,000 pages), 429 wait cap (1 h). |
| **In-process — JSONata** | `transform` Steps written in JSONata. | The `jsonata` v2.x evaluator. No host bindings, no I/O, no async. | Transform timeout (default 10 min). Memory bounded by the JSONata expression's own data size. |
| **QuickJS-WASM** | `transform` Steps written in JavaScript. Before-Request Hooks. | `quickjs-emscripten` WASM, bundled into the Bun binary at compile time. No host globals, no `fetch`, no `process`, no `Bun`, no FS. | 128 MB memory cap, 10 million opcode interrupt budget, 10 min wall-clock cap inherited from the transform tier. |
| **Ephemeral Docker container** | Custom tool units: shell scripts, custom images, long-running compute. Anything the operator declares as `kind: container`. | A fresh container per invocation, `--rm`, restricted egress network, mounted only with the inputs it declared, optional `sysbox-runc` runtime for stronger isolation. | 2 GB memory default, 1.0 vCPU default, both overridable per tool unit. Step timeout (default 1 h). No host networking by default; the tool declares the egress hosts it needs. |
| **Direct-`fetch` Docker client** | The engine's own client to the Docker Engine. Not a step kind — this is the layer underneath the Docker tier above. | Bun's native `fetch` over the unix socket at `/var/run/docker.sock`. No `dockerode`, no `node-docker-api`. | N/A — this is the control plane for the container tier, not a sandbox in itself. |

## Tier 1 — request driver, in process

The `request` Step runs in the engine process because the only thing it does is issue a network call through a Connector driver under the engine's own control. The driver does the dangerous parts (Credential decryption, header injection, URL composition) before the call leaves the process; no untrusted code is evaluated. The Before-Request Hook, when configured, runs in the QuickJS tier below and is treated as untrusted JavaScript even though its caller is trusted.

## Tier 2 — JSONata, in process

JSONata is a pure data-shaping expression language with no I/O, no host bindings, and no way to call out to JavaScript. The engine evaluates it directly inside the worker process because the worst it can do is be slow or allocate memory. The transform timeout (10 min) and the implicit memory ceiling of the worker are sufficient guards.

## Tier 3 — QuickJS-WASM

JavaScript transforms and Before-Request Hooks run inside `quickjs-emscripten`, a WASM build of the QuickJS interpreter. The engine constructs a fresh runtime per evaluation, sets a memory cap and an opcode interrupt budget, evaluates the expression, and disposes the runtime. There is no shared global state across evaluations.

**Trade-off vs `isolated-vm`**: `isolated-vm` is faster (it embeds V8) but is a native module, requires per-platform binaries, breaks the single-binary `bun build --compile` story, and historically has had supply-chain and rebuild friction. QuickJS-WASM is slower per opcode but compiles once, ships inside the binary, runs on every target Bun supports, and has a smaller and more inspectable threat surface.

The engine's QuickJS configuration:

- Memory cap: **128 MB**, set via `setMemoryLimit`.
- Interrupt budget: **10 million opcodes**, enforced via `setInterruptHandler` that increments a counter on every interrupt callback and aborts when the counter exceeds the budget.
- No host globals exposed: no `fetch`, no `process`, no `Bun`, no `globalThis.console` (a stub `console.log` writes into a captured buffer instead), no module loader, no `import`.
- Inputs are passed in as a single JSON value, marshalled via the QuickJS marshalling helpers, never as a live JS reference.
- Outputs are read back the same way, parsed once on the host side.
- A wall-clock guard (10 min default) runs on the host alongside the opcode counter; whichever fires first wins.

```ts
import { getQuickJS } from "quickjs-emscripten";

export async function evalTransform(source: string, input: unknown): Promise<unknown> {
  const QuickJS = await getQuickJS();
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(128 * 1024 * 1024);          // 128 MB

  let opcodes = 0;
  rt.setInterruptHandler(() => ++opcodes > 10_000_000);

  const ctx = rt.newContext();
  try {
    // marshal input as a JSON string the script reads via globalThis.__input__
    const inputHandle = ctx.newString(JSON.stringify(input));
    ctx.setProp(ctx.global, "__input__", inputHandle);
    inputHandle.dispose();

    // wrap the user source so we always get a JSON-serializable result back
    const wrapped = `JSON.stringify((function(input){ ${source} })(JSON.parse(__input__)))`;
    const result = ctx.evalCode(wrapped);

    if (result.error) {
      const err = ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`transform failed: ${JSON.stringify(err)}`);
    }
    const out = ctx.getString(result.value);
    result.value.dispose();
    return JSON.parse(out);
  } finally {
    ctx.dispose();
    rt.dispose();
  }
}
```

## Tier 4 — ephemeral Docker container

Steps that need to run a real binary, an arbitrary image, or a long-lived compute job declare a `container` tool unit. The engine creates a fresh container per invocation, mounts only the declared inputs, applies the resource caps, and removes the container on exit.

Defaults:

- **Memory**: 2 GB.
- **CPU**: 1.0 vCPU.
- **Filesystem**: read-only root with a tmpfs writable scratch directory of bounded size; declared input files mounted read-only, declared output paths captured after exit.
- **Network**: by default no host network. The tool unit declares the egress hosts it needs and the engine wires only those through the Docker network policy.
- **Lifetime**: `--rm` always; the container is destroyed immediately after the run, regardless of exit status.
- **User**: a non-root UID inside the container, mapped via `--user` and (when `sysbox-runc` is available) further isolated by the user namespace `sysbox-runc` provides.

**Trade-off — `sysbox-runc` is opt-in, not required**: `sysbox-runc` provides VM-grade isolation by giving each container its own kernel namespace surface and is the recommended runtime when the engine is hosting third-party code on a shared host. It is opt-in because (a) it is a separate runtime that has to be installed alongside Docker, (b) not all hosting environments allow custom OCI runtimes, and (c) for tenants running only their own custom tool units the default `runc` plus the engine's resource caps are already adequate. The engine reads a per-tenant or per-host configuration flag and selects `runtime: sysbox-runc` on the container create call when it is present.

## Tier 5 — direct-`fetch` Docker client

The engine talks to the Docker Engine API itself via Bun's native `fetch` over the unix socket. It does not depend on `dockerode`, `node-docker-api`, or any other Docker client library.

**Trade-off vs `dockerode`**: `dockerode` is a battle-tested Node client with a callback-flavored API, an extra dependency footprint, partial Bun compatibility, and a wrapper layer on top of the Docker Engine HTTP API that the engine would have to learn anyway. The Docker Engine HTTP API is small, stable, and documented; calling it directly with `fetch` is around 60 lines of app code total, removes a dependency, and lets the engine stream Docker logs through the same `ReadableStream` plumbing it uses everywhere else.

```ts
const SOCKET = "/var/run/docker.sock";

// Bun's fetch supports unix:// URLs natively
async function dockerRun(image: string, cmd: string[], opts: {
  memory: number; nanoCpus: number; networkMode: string;
}): Promise<{ id: string; exitCode: number; logs: ReadableStream<Uint8Array> }> {
  const create = await fetch(`unix://${SOCKET}/v1.43/containers/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      Image: image,
      Cmd: cmd,
      HostConfig: {
        AutoRemove: true,
        Memory: opts.memory,
        NanoCpus: opts.nanoCpus,
        NetworkMode: opts.networkMode,
        Runtime: process.env.DOCKER_RUNTIME ?? "runc", // "sysbox-runc" when opted in
      },
    }),
  });
  const { Id: id } = await create.json();

  await fetch(`unix://${SOCKET}/v1.43/containers/${id}/start`, { method: "POST" });

  const wait = await fetch(`unix://${SOCKET}/v1.43/containers/${id}/wait`, { method: "POST" });
  const { StatusCode: exitCode } = await wait.json();

  const logs = await fetch(
    `unix://${SOCKET}/v1.43/containers/${id}/logs?stdout=1&stderr=1&follow=0`,
  );
  return { id, exitCode, logs: logs.body! };
}
```

The same direct-`fetch` pattern is used for `images/create`, `containers/exec`, and the streaming `containers/{id}/attach` endpoint. Streaming endpoints return a `ReadableStream<Uint8Array>` that the engine pipes through its existing streaming machinery (see `07-streaming-and-reactivity.md`) without any client-library impedance mismatch.

## Tier selection summary

- A `request` Step always runs in tier 1.
- A JSONata `transform` always runs in tier 2.
- A JavaScript `transform` and every Before-Request Hook always run in tier 3.
- A custom tool unit declared with `kind: container` always runs in tier 4, talking through tier 5.
- The engine never silently downgrades a Step from a stricter tier into a weaker one. Misconfiguring a Step into the wrong tier fails Workflow validation at upsert time.
