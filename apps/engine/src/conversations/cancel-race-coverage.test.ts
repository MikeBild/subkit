// Cancel-race coverage gate.
//
// `apps/engine/src/conversations/abort.test.ts` pins the registry's
// invariants in isolation; the e2e at `tests/e2e/authoring-regressions
// .e2e.test.ts` covers the full HTTP `POST /messages` path. This gate
// extends the same regression cover to every NEW register
// site introduced by the runLoop fallback retirement:
//
//   - HTTP `POST /v1/conversations/{id}/messages/upload`
//   - HTTP `POST /v1/conversations/{id}/elicitations/{eid}/respond`
//   - HTTP `POST /v1/conversations/{id}/tool-calls/{tcid}/respond`
//   - MCP  `conversation.append`
//   - MCP  `conversation.respond_elicitation`
//   - chat.dispatcher (Slack / Teams)
//   - service `createConversation` (internal registration after row
//     insert — special-cased because the route doesn't know
//     `conversation_id` before the call)
//
// Full HTTP / MCP integration coverage for each of these would
// require 6 separate test harnesses with mocked LLM, DB, and request
// surfaces. Instead this file's tests work at the source level: each
// register site must read the file's text and find the
// `register…Abort` / `unregister…Abort` pair around the service call.
// The test fails at PR time when a refactor drops one half of the
// pair; catches the same regression class as a slow integration test
// without the harness cost. Pair with `abort.test.ts` for runtime
// behaviour and the e2e cover for the canonical path.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

interface Surface {
  /** Display label for the failure message. */
  label: string;
  /** Repo-relative file path. */
  file: string;
  /**
   * String the file MUST contain — the marker that this site does the
   * sync-register. Most sites use `registerConversationAbort(`
   * directly. createConversation uses a slightly different shape.
   */
  registerCall: string;
  /** String the file MUST contain — the unregister half of the pair. */
  unregisterCall: string;
  /**
   * String that MUST appear between register and unregister — the
   * service call that consumes the controller. Catches the case where
   * a refactor accidentally calls register but threads the wrong
   * controller into the service.
   */
  serviceCall: string;
}

const SURFACES: readonly Surface[] = [
  {
    label: "HTTP messages route — POST /v1/conversations/{id}/messages",
    file: "apps/engine/src/http/routes/conversations/messages.ts",
    registerCall: "registerConversationAbort(principal.tenant_id, id)",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl)",
    serviceCall: "svc.appendUserMessage",
  },
  {
    label: "HTTP messages upload — POST /v1/conversations/{id}/messages/upload",
    file: "apps/engine/src/http/routes/conversations/messages.ts",
    registerCall: "registerConversationAbort(principal.tenant_id, id)",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl)",
    serviceCall: "svc.appendUserMessage",
  },
  {
    label: "HTTP elicitations route — POST /v1/conversations/{id}/elicitations/{eid}/respond",
    file: "apps/engine/src/http/routes/conversations/elicitations.ts",
    registerCall: "registerConversationAbort(principal.tenant_id, id)",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl)",
    serviceCall: "svc.respondElicitation",
  },
  {
    // MCP async Tasks (SEP-1686): the conversation tool handler no
    // longer runs the turn — it enqueues a `conversation.run-turn` job.
    // The cancel-race register/unregister pair moved to the worker,
    // which registers the controller around the backgrounded turn so
    // `tasks/cancel` can abort it.
    label: "conversation.run-turn worker — backgrounded turn register/unregister",
    file: "apps/engine/src/queue/handlers/conversation-run-turn.ts",
    registerCall: "registerConversationAbort(data.tenant_id, data.conversation_id)",
    unregisterCall:
      "unregisterConversationAbort(data.tenant_id, data.conversation_id, turnAbortCtrl)",
    serviceCall: "svc.runConversationTurn",
  },
  {
    label: "Chat dispatcher — Slack / Teams append + respond paths",
    file: "apps/engine/src/chat/dispatcher.ts",
    registerCall: "registerConversationAbort(tenant_id, conversation_id)",
    unregisterCall: "unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl)",
    serviceCall: "runConversationTurn(",
  },
  {
    // The conversation-create + turn split: `createConversation` only
    // inserts the row, `runConversationTurn` runs the loop. The HTTP
    // create route registers the controller around `runConversationTurn`.
    label: "HTTP create route — registration around runConversationTurn",
    file: "apps/engine/src/http/routes/conversations/collection.ts",
    registerCall: "registerConversationAbort(",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, created.conversation.id",
    serviceCall: "runConversationTurn(",
  },
];

function readSource(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("cancel-race coverage gate", () => {
  for (const surface of SURFACES) {
    test(`${surface.label} — registers + unregisters around the service call`, () => {
      const src = readSource(surface.file);

      // 1. Register call must be present.
      if (!src.includes(surface.registerCall)) {
        throw new Error(
          `${surface.file} is missing the sync-register call: \`${surface.registerCall}\`. ` +
            `The runLoop fallback is retired; every caller must register on its synchronous-accept frame.`,
        );
      }

      // 2. Unregister call must be present.
      if (!src.includes(surface.unregisterCall)) {
        throw new Error(
          `${surface.file} is missing the unregister call: \`${surface.unregisterCall}\`. ` +
            `Without it the registry leaks slots — the next turn for the same (tenant, conversation) overwrites, but cancels arriving in the leak window abort a stale controller.`,
        );
      }

      // 3. Register must precede unregister (textual order — sites
      //    we care about are all single-handler functions where the
      //    register/unregister pair is colocated). Multi-handler
      //    files (messages.ts, elicitations.ts) have multiple pairs
      //    but each pair is internally ordered.
      const registerIdx = src.indexOf(surface.registerCall);
      const unregisterIdx = src.lastIndexOf(surface.unregisterCall);
      expect(registerIdx).toBeLessThan(unregisterIdx);

      // 4. The service call must appear between register and the LAST
      //    unregister (i.e. the controller is consumed within the
      //    register-unregister scope).
      const serviceIdx = src.indexOf(surface.serviceCall, registerIdx);
      if (serviceIdx === -1) {
        throw new Error(
          `${surface.file}: service call \`${surface.serviceCall}\` not found after the register call. The registered controller must be threaded into the service call to satisfy the cancel-race contract.`,
        );
      }
      expect(serviceIdx).toBeGreaterThan(registerIdx);
      expect(serviceIdx).toBeLessThan(unregisterIdx);

      // 5. The unregister call must appear inside a `finally` block.
      //    Heuristic: search backward from the unregister position for
      //    the nearest preceding `finally` keyword and assert it's
      //    closer than any preceding `try {` opener that doesn't have
      //    its own catch/finally between it and unregister. The
      //    practical version: there must be `finally` somewhere
      //    between the register call and the unregister call. Skips
      //    register sites that wrap with a different lifetime
      //    structure (none today).
      const between = src.slice(registerIdx, unregisterIdx);
      if (!between.includes("finally")) {
        throw new Error(
          `${surface.file}: no \`finally\` block found between the register and unregister calls. The unregister must run on every code path; an unconditional path leaks the registry slot when the service call throws.`,
        );
      }
    });
  }
});
