export const QUALITY_RUNTIME_WITNESSES = [
  {
    consumer: "apps/engine/src/conversations/index.ts",
    test: "apps/engine/src/conversations/index.contract.test.ts",
    kind: "source-process",
    rationale:
      "An isolated Bun subprocess imports the unchanged public conversation index with representative original modules and verifies exported function and schema identities without module mocks.",
    independent_review:
      "Conversation facade migration review verifies source import initialization, constructor and schema identity, and the public function surface.",
  },
  {
    consumer: "apps/engine/src/embeddings/embedding-worker.ts",
    test: "apps/engine/src/embeddings/tests/worker-entry.test.ts",
    kind: "source-worker",
    rationale:
      "A Worker constructed from the exact source URL receives the production availability protocol and must return a correlated response.",
    independent_review:
      "h3_inventory independently reviewed the source Worker URL, actual protocol assertions and passing focused execution.",
  },
  ...["assert-search-path-or-abort", "print-key"].map((file) => ({
    consumer: `apps/engine/src/db/${file}.ts`,
    test: `apps/engine/src/db/${file}.contract.test.ts`,
    kind: "source-process",
    rationale:
      "Isolated subprocess dynamically imports the unchanged source entrypoint. Only database/identity/logging I/O boundaries are mocked; assertions verify real success/failure exits and observable output.",
    independent_review:
      "h3_inventory independently reviewed both subprocess dispatches, failure semantics, database cleanup and key-output secrecy; focused contracts passed.",
  })),
  ...["index.ts", "engine-main.ts", "smoke.ts"].map((file) => ({
    consumer: `apps/engine/src/${file}`,
    test: "apps/engine/src/tests/source-smoke.contract.test.ts",
    kind: "source-process",
    rationale:
      "The test launches the repository index.ts --smoke; the production branch imports engine-main and calls runSmoke, exercising real worker calculations and redaction with success assertions.",
    independent_review:
      "h3_inventory independently reviewed the exact source dispatch and reran the source smoke successfully (1 test, 5 assertions).",
  })),
  ...["index.ts", "sandboxes/quickjs/worker.ts"].map((file) => ({
    consumer: `apps/engine/src/${file}`,
    test: "apps/engine/src/sandboxes/quickjs/tests/worker-entrypoint.contract.test.ts",
    kind: "source-process",
    rationale:
      "The test forks source index.ts --sandbox-worker, verifies the production IPC readiness handshake and evaluates JavaScript to the asserted result 42.",
    independent_review:
      "Root inspected the exact index source dispatch to runSandboxWorker and the real IPC request/result assertions after lifecycle hardening.",
  })),
];
