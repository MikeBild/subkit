import { describe, expect, test } from "bun:test";
import { type PaymentResume, resumePaymentStep } from "@/api/vault";
import { render } from "@/features/settings/model/settings-fixtures";
import { translate } from "@/lib/i18n";
import { type DecisionPorts, decidePayment, PANEL_START, panelStep } from "./model/payments";
import { ResumeNotice } from "./payments";

const ID = "6f1c2b9e-4a7d-4c1e-9b3a-2d5e8f7a1c04";
const RESUME: PaymentResume = { conversation_id: "conv-1", tool_call_id: "call-1" };

function recordingPorts(options: { resume?: PaymentResume | null; resumeFails?: boolean } = {}): {
  ports: DecisionPorts;
  calls: string[];
} {
  const calls: string[] = [];
  const resume = options.resume === undefined ? RESUME : options.resume;
  return {
    calls,
    ports: {
      approve: async (id, cvv) => {
        calls.push(`approve:${id}:${cvv}`);
        return { resume };
      },
      reject: async (id) => {
        calls.push(`reject:${id}`);
        return { resume };
      },
      resume: async (target, confirmed) => {
        calls.push(`respond:${target.conversation_id}:${target.tool_call_id}:${confirmed}`);
        if (options.resumeFails) throw Object.assign(new Error("busy"), { status: 409 });
      },
    },
  };
}

describe("payment decision resumes the chat", () => {
  test("approve is followed right away by confirmed true on the paused tool call", async () => {
    const { ports, calls } = recordingPorts();
    const outcome = await decidePayment(ports, { kind: "approve", id: ID, cvv: "737" });
    expect(calls).toEqual([`approve:${ID}:737`, "respond:conv-1:call-1:true"]);
    expect(outcome).toEqual({ pending: { resume: RESUME, confirmed: true }, resumed: true });
  });

  test("reject answers the tool call with confirmed false", async () => {
    const { ports, calls } = recordingPorts();
    await decidePayment(ports, { kind: "reject", id: ID });
    expect(calls).toEqual([`reject:${ID}`, "respond:conv-1:call-1:false"]);
  });

  test("a workflow payment without resume target does not respond", async () => {
    const { ports, calls } = recordingPorts({ resume: null });
    const outcome = await decidePayment(ports, { kind: "approve", id: ID, cvv: "737" });
    expect(calls).toEqual([`approve:${ID}:737`]);
    expect(outcome).toEqual({ pending: null, resumed: false });
  });

  test("a failed approval never responds", async () => {
    const { ports, calls } = recordingPorts();
    const failing: DecisionPorts = {
      ...ports,
      approve: async () => {
        throw Object.assign(new Error("gone"), { status: 410 });
      },
    };
    await expect(decidePayment(failing, { kind: "approve", id: ID, cvv: "737" })).rejects.toThrow(
      "gone",
    );
    expect(calls).toEqual([]);
  });

  test("a failed respond keeps the target for a retry and the panel shows it", async () => {
    const { ports } = recordingPorts({ resumeFails: true });
    const outcome = await decidePayment(ports, { kind: "approve", id: ID, cvv: "737" });
    expect(outcome.resumed).toBe(false);
    expect(outcome.pending).toEqual({ resume: RESUME, confirmed: true });
    const approved = panelStep(PANEL_START, { type: "approved" });
    const failed = panelStep(approved, { type: "resumeFailed", pending: outcome.pending! });
    expect(failed.phase).toBe("submitted");
    expect(failed.resumeFailed).toEqual(outcome.pending);
    expect(panelStep(failed, { type: "resumed" }).resumeFailed).toBeNull();
    const html = render(
      <ResumeNotice pending={failed.resumeFailed} retrying={false} onRetry={() => {}} />,
      "en",
    );
    expect(html).toContain(translate("en", "vault.payment.resumeFailed"));
    expect(html).toContain('data-testid="vault-payment-resume-retry"');
    expect(render(<ResumeNotice pending={null} retrying={false} onRetry={() => {}} />, "en")).toBe(
      "",
    );
  });
});

describe("resumePaymentStep", () => {
  test("resolves on the first streamed event without waiting for the whole turn", async () => {
    const sent: unknown[] = [];
    let finish: () => void = () => {};
    const step = await resumePaymentStep(RESUME, true, (id, call, output, onEvent) => {
      sent.push({ id, call, output });
      queueMicrotask(() => onEvent?.({ type: "tool_result" }));
      return new Promise((resolve) => {
        finish = () => resolve({} as never);
      });
    });
    expect(sent).toEqual([{ id: "conv-1", call: "call-1", output: { confirmed: true } }]);
    let done = false;
    void step.finished.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await step.finished;
    expect(done).toBe(true);
  });

  test("rejects when the stream fails before any event", async () => {
    await expect(
      resumePaymentStep(RESUME, false, () =>
        Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
      ),
    ).rejects.toThrow("not found");
  });
});
