import { describe, expect, test } from "bun:test";
import { exitCodeForTerminalStatus, followExecution, tailExecution } from "./tail-execution.ts";

const stream = (sse: string) => async () =>
  new Response(sse, { headers: { "content-type": "text/event-stream" } });

describe("tailExecution", () => {
  test("an unknown outcome stops the tail and is not a success", async () => {
    const sse =
      'event: execution.uncertain\ndata: {"execution_id":"e1","step_keys":["send_mail"]}\n\n' +
      'event: execution.step.finished\ndata: {"step_key":"later"}\n\n';
    const lines: string[] = [];
    const terminal = await tailExecution({ streamExecution: stream(sse) }, "e1", {
      write: (line) => lines.push(line),
    });
    expect(terminal).toBe("uncertain");
    expect(lines).toHaveLength(1);
    expect(exitCodeForTerminalStatus(terminal)).toBe(1);
  });
});

describe("followExecution", () => {
  test("prints the uncertain step and the exact command to resolve it", async () => {
    const sse = 'event: execution.uncertain\ndata: {"execution_id":"e1"}\n\n';
    const printed: string[] = [];
    const terminal = await followExecution(
      {
        streamExecution: stream(sse),
        getExecution: async () =>
          ({ status: "uncertain", error: { step_id: "send_mail" } }) as never,
        executionSteps: async () => ({ items: [] }) as never,
      },
      "e1",
      { write: (text) => printed.push(text) },
    );
    expect(terminal).toBe("uncertain");
    expect(printed.join("")).toContain(
      "subkit executions resolve-write e1 --step send_mail --outcome not_arrived",
    );
  });

  test("a finished run prints nothing extra", async () => {
    const printed: string[] = [];
    const terminal = await followExecution(
      {
        streamExecution: stream('event: execution.succeeded\ndata: {"status":"succeeded"}\n\n'),
        getExecution: async () => ({ status: "succeeded" }) as never,
        executionSteps: async () => ({ items: [] }) as never,
      },
      "e1",
      { write: (text) => printed.push(text) },
    );
    expect(terminal).toBe("succeeded");
    expect(printed).toEqual([]);
  });
});
