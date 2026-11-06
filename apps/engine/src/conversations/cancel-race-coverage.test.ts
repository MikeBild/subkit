import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

interface Surface {
  label: string;
  file: string;
  registerCall: string;
  unregisterCall: string;
  serviceCall: string;
}

const SURFACES: readonly Surface[] = [
  {
    label: "HTTP messages route — POST /v1/conversations/{id}/messages",
    file: "apps/engine/src/http/routes/conversations/messages.ts",
    registerCall: "registerConversationAbort(principal.tenant_id, id, db)",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl)",
    serviceCall: "svc.appendUserMessage",
  },
  {
    label: "HTTP messages upload — POST /v1/conversations/{id}/messages/upload",
    file: "apps/engine/src/http/routes/conversations/messages.ts",
    registerCall: "registerConversationAbort(principal.tenant_id, id, db)",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl)",
    serviceCall: "svc.appendUserMessage",
  },
  {
    label: "HTTP elicitations route — POST /v1/conversations/{id}/elicitations/{eid}/respond",
    file: "apps/engine/src/http/routes/conversations/elicitations.ts",
    registerCall: "registerConversationAbort(principal.tenant_id, id, db)",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, id, turnAbortCtrl)",
    serviceCall: "svc.respondElicitation",
  },
  {
    label: "conversation.run-turn worker — backgrounded turn register/unregister",
    file: "apps/engine/src/queue/handlers/conversation-run-turn.ts",
    registerCall: "registerConversationAbort(data.tenant_id, data.conversation_id, db,",
    unregisterCall:
      "unregisterConversationAbort(data.tenant_id, data.conversation_id, turnAbortCtrl)",
    serviceCall: "svc.runConversationTurn",
  },
  {
    label: "Chat dispatcher — Slack / Teams append + respond paths",
    file: "apps/engine/src/chat/dispatcher.ts",
    registerCall: "registerConversationAbort(tenant_id, conversation_id, db)",
    unregisterCall: "unregisterConversationAbort(tenant_id, conversation_id, turnAbortCtrl)",
    serviceCall: "runConversationTurn(",
  },
  {
    label: "HTTP create route — registration around runConversationTurn",
    file: "apps/engine/src/http/routes/conversations/collection.ts",
    registerCall: "registerConversationAbort(",
    unregisterCall: "unregisterConversationAbort(principal.tenant_id, created.conversation.id",
    serviceCall: "runConversationTurn(",
  },
  {
    label: "HTTP compact route",
    file: "apps/engine/src/api/operations/conversation-lifecycle.ts",
    registerCall: "registerConversationAbort(scope.tenant_id, id, scope.db)",
    unregisterCall: "unregisterConversationAbort(scope.tenant_id, id, ctrl)",
    serviceCall: "svc.compactConversation(",
  },
  {
    label: "Direct conversation tool invocation",
    file: "apps/engine/src/conversations/direct-invoke.ts",
    registerCall: "acquireConversationTurn(p.tenant_id, p.conversation_id, p.db)",
    unregisterCall: "releaseConversationTurn(p.tenant_id, p.conversation_id, ctrl)",
    serviceCall: "driveDirectTool(",
  },
];

function normalizeSource(source: string): string {
  return source.replace(/,\s*\)/g, ")").replace(/\s+/g, "");
}

function readSource(rel: string): string {
  return normalizeSource(readFileSync(resolve(ROOT, rel), "utf8"));
}

describe("cancel-race coverage gate", () => {
  for (const surface of SURFACES) {
    test(`${surface.label} — registers + unregisters around the service call`, () => {
      const src = readSource(surface.file);

      if (!src.includes(normalizeSource(surface.registerCall))) {
        throw new Error(
          `${surface.file} is missing the reservation call: \`${surface.registerCall}\`. ` +
            `The runLoop fallback is retired; every caller must register on its synchronous-accept frame.`,
        );
      }

      if (!src.includes(normalizeSource(surface.unregisterCall))) {
        throw new Error(
          `${surface.file} is missing the unregister call: \`${surface.unregisterCall}\`. ` +
            `Without it the registry leaks slots — the next turn for the same (tenant, conversation) overwrites, but cancels arriving in the leak window abort a stale controller.`,
        );
      }

      const registerIdx = src.indexOf(normalizeSource(surface.registerCall));
      const unregisterIdx = src.lastIndexOf(normalizeSource(surface.unregisterCall));
      expect(registerIdx).toBeLessThan(unregisterIdx);

      const serviceIdx = src.indexOf(normalizeSource(surface.serviceCall), registerIdx);
      if (serviceIdx === -1) {
        throw new Error(
          `${surface.file}: service call \`${surface.serviceCall}\` not found after the register call. The registered controller must be threaded into the service call to satisfy the cancel-race contract.`,
        );
      }
      expect(serviceIdx).toBeGreaterThan(registerIdx);
      expect(serviceIdx).toBeLessThan(unregisterIdx);

      const between = src.slice(registerIdx, unregisterIdx);
      if (!between.includes("finally")) {
        throw new Error(
          `${surface.file}: no \`finally\` block found between the register and unregister calls. The unregister must run on every code path; an unconditional path leaks the registry slot when the service call throws.`,
        );
      }
    });
  }
});
