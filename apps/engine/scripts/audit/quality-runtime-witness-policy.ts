export const QUALITY_RUNTIME_WITNESSES = [
  {
    consumer: "apps/engine/src/speech/local/whisper-worker.ts",
    test: "apps/engine/src/speech/local/whisper-worker.test.ts",
    kind: "source-worker",
    rationale:
      "A Worker constructed from the exact source URL receives the production transcribe protocol and must return a correlated response even when the local model is absent.",
    independent_review:
      "Added with the voice dictation change; the focused worker test exercises the real entry and protocol.",
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
  ...["http.ts", "scheduler.ts", "shutdown.ts", "worker.ts"].map((file) => ({
    consumer: `apps/engine/src/composition/${file}`,
    test: "apps/engine/src/tests/source-boot.contract.test.ts",
    kind: "source-process",
    rationale:
      "The test launches the source index.ts without flags against its own test database; engine-main runs startWorker, startScheduler, runBootSeeds and startHttp, the test waits for the ready and scheduler-installed events, gets 200 from /health, sends SIGTERM and asserts exit code 0 with shutdown.complete.",
    independent_review:
      "No separate review: the pair is accepted only through the hash-bound passing execution receipt that record-quality-runtime-witnesses.ts writes for this exact source and test.",
  })),
];
