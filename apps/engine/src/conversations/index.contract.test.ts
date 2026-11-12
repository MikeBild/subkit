import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const answerActorPath = fileURLToPath(new URL("./answer-actor.ts", import.meta.url));
const servicePath = fileURLToPath(new URL("./service.ts", import.meta.url));
const playbookPath = fileURLToPath(new URL("./playbook-contract.ts", import.meta.url));
const resumePath = fileURLToPath(new URL("./resume-form.ts", import.meta.url));
const CHILD_TIMEOUT_MS = 15_000;
const CONTRACT_TEST_TIMEOUT_MS = 20_000;

function runChild(script: string, timeout = CHILD_TIMEOUT_MS) {
  return Bun.spawnSync([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: { ...process.env, NODE_ENV: "test", OTEL_SDK_DISABLED: "true" },
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1_048_576,
  });
}

function childFailure(child: ReturnType<typeof runChild>) {
  const stderr = new TextDecoder().decode(child.stderr);
  const stdout = new TextDecoder().decode(child.stdout);
  return `conversation public index child failed: exit=${child.exitCode}; signal=${child.signalCode ?? "none"}; timed_out=${child.exitedDueToTimeout === true}; stderr=${stderr}; stdout=${stdout}`;
}

test(
  "conversation public index initializes and preserves its contract exports",
  () => {
    const script = `
    const publicIndex = await import(${JSON.stringify(indexPath)});
    const answerActor = await import(${JSON.stringify(answerActorPath)});
    const service = await import(${JSON.stringify(servicePath)});
    const playbook = await import(${JSON.stringify(playbookPath)});
    const resume = await import(${JSON.stringify(resumePath)});
    const requiredFunctions = [
      "cancelConversationAbort",
      "completeApprovalBackedElicitation",
      "createConversation",
      "getConversation",
      "listConversations",
      "runConversationTurn",
      "serializeEvent",
      "timeoutPhaseOf",
    ];
    for (const name of requiredFunctions) {
      if (typeof publicIndex[name] !== "function") throw new Error("missing function: " + name);
    }
    if (publicIndex.humanChatAnswer !== answerActor.humanChatAnswer) throw new Error("answer actor identity changed");
    if (publicIndex.createConversation !== service.createConversation) throw new Error("service identity changed");
    if (publicIndex.PlaybookViewSchema !== playbook.PlaybookViewSchema) throw new Error("playbook schema identity changed");
    if (publicIndex.ResumeFormFieldSchema !== resume.ResumeFormFieldSchema) throw new Error("resume schema identity changed");
    if (!publicIndex.PlaybookViewSchema.safeParse({
      id: "playbook-1",
      title: "Title",
      goal: "Goal",
      revision: 0,
      status: "open",
      summary: "Summary",
      steps: [],
      next_action: null,
      completion: { status: "open", label: "Pending", reason: "No completion yet" },
      updated_at: "2026-01-01T00:00:00.000Z",
    }).success) throw new Error("playbook schema unavailable");
    if (publicIndex.ResumeFormFieldSchema.safeParse({}).success) throw new Error("resume schema accepted invalid field");
    console.log("conversation-public-index-ok");
  `;
    const child = runChild(script);
    if (child.exitCode !== 0) throw new Error(childFailure(child));
    expect(new TextDecoder().decode(child.stdout)).toContain("conversation-public-index-ok");
  },
  CONTRACT_TEST_TIMEOUT_MS,
);

test("conversation public index contract kills an unresponsive child within its own budget", () => {
  const child = runChild("await new Promise(() => {});", 100);
  expect(child.exitCode).not.toBe(0);
  expect(child.exitedDueToTimeout).toBe(true);
  expect(child.signalCode).toBe("SIGKILL");
});
