import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nContext } from "@/lib/i18n-context";

const CHILD_FLAG = "SUBKIT_WORKFLOW_REVIEW_DOM_CHILD";

function isolated(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (process.env[CHILD_FLAG] !== "1") {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "-t", name], {
        env: { ...process.env, [CHILD_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return;
    }
    await body();
  });
}

const receipt = (digest = "digest-a", status: "pending" | "completed" = "pending") => ({
  receipt_id: "receipt-a",
  status,
  snapshot_digest: digest,
  expires_at: "2099-01-01T00:00:00.000Z",
  workflow_name: "Daily report",
  workflow_slug: "daily-report",
  reviewed_version_number: 3,
  environment: "dev",
  description: "Review the change",
  checks: [],
  effects: [],
  affected_triggers: [],
  actions: { activate: false, grant: null, schedule: null },
  suggested_actions: { activate: false, grant: null, schedule: null },
  result:
    status === "completed"
      ? {
          workflow_id: "workflow-a",
          authority_id: null,
          schedule_id: null,
          saved: true,
          activated: false,
          granted: false,
        }
      : null,
});

type FetchCall = { path: string; init: RequestInit };

async function mounted(respond: (call: FetchCall) => Promise<Response> | Response): Promise<{
  dom: JSDOM;
  root: Root;
  calls: FetchCall[];
  flush: () => Promise<void>;
  remount: (conversationId?: string, elicitationId?: string) => Promise<void>;
  hide: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  dom.window.scrollTo = () => {};
  dom.window.matchMedia = (media: string) =>
    ({
      matches: false,
      media,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  const calls: FetchCall[] = [];
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    scrollTo: () => {},
    fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call = { path: String(input), init };
      calls.push(call);
      return respond(call);
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  mock.module("./workflow-review-dialog", () => ({
    WorkflowReviewDialog: (props: {
      state: string;
      review: { workflow_slug: string; reviewed_version_label: string } | null;
      remember: boolean;
      policyBusy: boolean;
      onComplete: (saveOnly: boolean) => void;
      onCheckResult: () => void;
      onGrantChange: (checked: boolean) => void;
      onRememberChange: (checked: boolean) => void;
    }) => (
      <div
        data-testid="workflow-review"
        data-state={props.state}
        data-digest={props.review?.reviewed_version_label ?? ""}
        data-remember={String(props.remember)}
        data-policy-busy={String(props.policyBusy)}
      >
        <button
          type="button"
          data-testid="finalize"
          disabled={props.state !== "ready"}
          onClick={() => props.onComplete(false)}
        />
        <button
          type="button"
          data-testid="save-only"
          disabled={props.state !== "ready"}
          onClick={() => props.onComplete(true)}
        />
        <button type="button" data-testid="check-result" onClick={props.onCheckResult} />
        <button type="button" data-testid="grant" onClick={() => props.onGrantChange(true)} />
        <button type="button" data-testid="remember" onClick={() => props.onRememberChange(true)} />
      </div>
    ),
  }));
  const { createRoot } = await import("react-dom/client");
  const { i18nValue } = await import("./patterns/test-utils");
  const { WorkflowReview } = await import("./workflow-review");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
  };
  const remount = async (conversationId = "conversation-a", elicitationId = "decision-a") => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nContext.Provider value={i18nValue()}>
            <WorkflowReview
              conversationId={conversationId}
              elicitationId={elicitationId}
              open
              onOpenChange={() => {}}
            />
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
    await flush();
  };
  const hide = async () => {
    await act(async () => root.render(null));
    await flush();
  };
  await remount();
  return {
    dom,
    root,
    calls,
    flush,
    remount,
    hide,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      dom.window.close();
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reviewPath(call: FetchCall): boolean {
  return call.path.includes("/workflow-reviews");
}

isolated("finalization is single-flight and keeps the reviewed digest", async () => {
  let resolveFinalize: ((response: Response) => void) | undefined;
  const view = await mounted((call) => {
    if (call.path.endsWith("/tool-policies"))
      return json({ policies: {}, eligible_no_confirm_tools: ["save_workflow_draft"] });
    if (call.path.endsWith("/finalize"))
      return new Promise<Response>((resolve) => {
        resolveFinalize = resolve;
      });
    if (reviewPath(call)) return json(receipt());
    throw new Error(`unexpected ${call.path}`);
  });
  try {
    const button = view.dom.window.document.querySelector(
      '[data-testid="finalize"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(view.calls.filter((call) => call.path.endsWith("/finalize"))).toHaveLength(1);
    expect(
      JSON.parse(String(view.calls.find((call) => call.path.endsWith("/finalize"))?.init.body)),
    ).toEqual({
      expected_snapshot_digest: "digest-a",
    });
    resolveFinalize?.(json(receipt("digest-a", "completed")));
    await view.flush();
  } finally {
    await view.close();
  }
});

isolated(
  "an uncertain finalize checks the persisted receipt instead of finalizing again",
  async () => {
    let finalized = false;
    const view = await mounted((call) => {
      if (call.path.endsWith("/tool-policies"))
        return json({ policies: {}, eligible_no_confirm_tools: ["save_workflow_draft"] });
      if (call.path.endsWith("/finalize")) {
        finalized = true;
        return json({ code: "upstream" }, 502);
      }
      if (call.path.endsWith("/receipt-a")) return json(receipt("digest-a", "completed"));
      if (reviewPath(call)) return json(receipt());
      throw new Error(`unexpected ${call.path}`);
    });
    try {
      await act(async () =>
        (
          view.dom.window.document.querySelector('[data-testid="finalize"]') as HTMLButtonElement
        ).click(),
      );
      await view.flush();
      expect(finalized).toBe(true);
      expect(
        view.dom.window.document
          .querySelector('[data-testid="workflow-review"]')
          ?.getAttribute("data-state"),
      ).toBe("uncertain");
      await act(async () =>
        (
          view.dom.window.document.querySelector(
            '[data-testid="check-result"]',
          ) as HTMLButtonElement
        ).click(),
      );
      await view.flush();
      expect(view.calls.filter((call) => call.path.endsWith("/finalize"))).toHaveLength(1);
      expect(view.calls.some((call) => call.path.endsWith("/receipt-a"))).toBe(true);
      expect(
        view.dom.window.document
          .querySelector('[data-testid="workflow-review"]')
          ?.getAttribute("data-state"),
      ).toBe("completed");
    } finally {
      await view.close();
    }
  },
);

isolated(
  "a changed receipt disables completion until its replacement review is ready",
  async () => {
    let resolveChanged: ((response: Response) => void) | undefined;
    let reviews = 0;
    const view = await mounted((call) => {
      if (call.path.endsWith("/tool-policies"))
        return json({ policies: {}, eligible_no_confirm_tools: ["save_workflow_draft"] });
      if (reviewPath(call)) {
        reviews++;
        if (reviews === 1) return json(receipt());
        return new Promise<Response>((resolve) => {
          resolveChanged = resolve;
        });
      }
      throw new Error(`unexpected ${call.path}`);
    });
    try {
      await act(async () =>
        (
          view.dom.window.document.querySelector('[data-testid="grant"]') as HTMLButtonElement
        ).click(),
      );
      expect(
        (view.dom.window.document.querySelector('[data-testid="finalize"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      resolveChanged?.(json(receipt("digest-b")));
      await view.flush();
      expect(
        (view.dom.window.document.querySelector('[data-testid="finalize"]') as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    } finally {
      await view.close();
    }
  },
);

isolated("save-only finalization retains the reviewed digest and marks save_only", async () => {
  const view = await mounted((call) => {
    if (call.path.endsWith("/tool-policies"))
      return json({ policies: {}, eligible_no_confirm_tools: ["save_workflow_draft"] });
    if (call.path.endsWith("/finalize")) return json(receipt("digest-a", "completed"));
    if (reviewPath(call)) return json(receipt());
    throw new Error(`unexpected ${call.path}`);
  });
  try {
    await act(async () =>
      (
        view.dom.window.document.querySelector('[data-testid="save-only"]') as HTMLButtonElement
      ).click(),
    );
    await view.flush();
    expect(
      JSON.parse(String(view.calls.find((call) => call.path.endsWith("/finalize"))?.init.body)),
    ).toEqual({
      expected_snapshot_digest: "digest-a",
      save_only: true,
    });
  } finally {
    await view.close();
  }
});

isolated("a policy error does not grant the no-confirm preference", async () => {
  const view = await mounted((call) => {
    if (call.path.endsWith("/tool-policies") && call.init.method === "PUT")
      return json({ code: "forbidden" }, 403);
    if (call.path.endsWith("/tool-policies"))
      return json({ policies: {}, eligible_no_confirm_tools: ["save_workflow_draft"] });
    if (reviewPath(call)) return json(receipt());
    throw new Error(`unexpected ${call.path}`);
  });
  try {
    await act(async () =>
      (
        view.dom.window.document.querySelector('[data-testid="remember"]') as HTMLButtonElement
      ).click(),
    );
    await view.flush();
    expect(
      view.dom.window.document
        .querySelector('[data-testid="workflow-review"]')
        ?.getAttribute("data-remember"),
    ).toBe("false");
    expect(
      view.calls.filter(
        (call) => call.path.endsWith("/tool-policies") && call.init.method === "PUT",
      ),
    ).toHaveLength(1);
  } finally {
    await view.close();
  }
});

isolated(
  "a pending receipt is recovered after remount without preparing or finalizing again",
  async () => {
    const view = await mounted((call) => {
      if (call.path.endsWith("/tool-policies"))
        return json({ policies: {}, eligible_no_confirm_tools: ["save_workflow_draft"] });
      if (call.path.endsWith("/receipt-a")) return json(receipt());
      if (reviewPath(call)) return json(receipt());
      throw new Error(`unexpected ${call.path}`);
    });
    try {
      await view.hide();
      await view.remount();
      expect(
        view.calls.filter((call) => reviewPath(call) && call.init.method === "POST"),
      ).toHaveLength(1);
      expect(
        view.calls.filter(
          (call) => call.path.endsWith("/receipt-a") && (call.init.method ?? "GET") === "GET",
        ),
      ).toHaveLength(1);
      expect(view.calls.filter((call) => call.path.endsWith("/finalize"))).toHaveLength(0);
    } finally {
      await view.close();
    }
  },
);

isolated("a receipt cannot cross a conversation or pending-decision boundary", async () => {
  const view = await mounted((call) => {
    if (call.path.endsWith("/tool-policies"))
      return json({ policies: {}, eligible_no_confirm_tools: ["save_workflow_draft"] });
    if (reviewPath(call)) return json(receipt());
    throw new Error(`unexpected ${call.path}`);
  });
  try {
    await view.hide();
    await view.remount("conversation-b", "decision-b");
    expect(
      view.calls.filter((call) => reviewPath(call) && call.init.method === "POST"),
    ).toHaveLength(2);
    expect(view.calls.some((call) => call.path.endsWith("/receipt-a"))).toBe(false);
  } finally {
    await view.close();
  }
});
