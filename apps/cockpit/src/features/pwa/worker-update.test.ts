import { describe, expect, test } from "bun:test";
import {
  pageRunsBuild,
  pageScripts,
  settleInstalledWorker,
  updateCheckDelay,
} from "./worker-update";

const origin = "https://app.example.test";
const shell = ["/cockpit/assets/index-new.js", "/cockpit/assets/react-new.js"];

function worker(state: ServiceWorkerState) {
  const sent: unknown[] = [];
  return {
    sent,
    state,
    postMessage: (message: unknown) => {
      sent.push(message);
    },
    addEventListener: () => {},
  };
}

describe("does this page already run the waiting build", () => {
  test("yes when every module script of the page belongs to that build", () => {
    expect(pageRunsBuild(["/cockpit/assets/index-new.js"], shell)).toBeTrue();
    expect(pageRunsBuild(shell, shell)).toBeTrue();
  });

  test("no when a script is from another build or nothing is known", () => {
    expect(pageRunsBuild(["/cockpit/assets/index-old.js"], shell)).toBeFalse();
    expect(pageRunsBuild([], shell)).toBeFalse();
    expect(pageRunsBuild(["/cockpit/assets/index-new.js"], null)).toBeFalse();
    expect(pageRunsBuild(["/cockpit/assets/index-new.js"], "index-new")).toBeFalse();
  });

  test("page scripts are read as same-origin paths", () => {
    expect(
      pageScripts(
        [
          { src: `${origin}/cockpit/assets/index-new.js` },
          { src: "/cockpit/assets/react-new.js" },
          { src: "https://cdn.example.test/x.js" },
        ],
        origin,
        `${origin}/cockpit/i/1/`,
      ),
    ).toEqual(shell);
  });
});

describe("a newly installed worker", () => {
  test("is ignored on a first install", async () => {
    const fresh = worker("installed");
    const outcome = await settleInstalledWorker({
      worker: fresh,
      superseding: false,
      scripts: ["/cockpit/assets/index-old.js"],
      describe: async () => ({ shell }),
    });
    expect(outcome).toBe("ignored");
    expect(fresh.sent).toEqual([]);
  });

  test("is ignored until it has finished installing", async () => {
    const outcome = await settleInstalledWorker({
      worker: worker("installing"),
      superseding: true,
      scripts: [],
      describe: async () => ({ shell }),
    });
    expect(outcome).toBe("ignored");
  });

  test("takes over quietly when the page already runs its build", async () => {
    const same = worker("installed");
    const outcome = await settleInstalledWorker({
      worker: same,
      superseding: true,
      scripts: ["/cockpit/assets/index-new.js"],
      describe: async () => ({ shell }),
    });
    expect(outcome).toBe("activated");
    expect(same.sent).toEqual([{ type: "activate-update" }]);
  });

  test("waits for the reload offer when the page runs an older build", async () => {
    const newer = worker("installed");
    const outcome = await settleInstalledWorker({
      worker: newer,
      superseding: true,
      scripts: ["/cockpit/assets/index-old.js"],
      describe: async () => ({ shell }),
    });
    expect(outcome).toBe("offered");
    expect(newer.sent).toEqual([]);
  });

  test("a worker that does not answer is offered, never activated blindly", async () => {
    const silent = worker("installed");
    const outcome = await settleInstalledWorker({
      worker: silent,
      superseding: true,
      scripts: ["/cockpit/assets/index-new.js"],
      describe: async () => null,
    });
    expect(outcome).toBe("offered");
    expect(silent.sent).toEqual([]);
  });
});

describe("asking the server for a newer worker", () => {
  test("happens at once the first time and after a reconnect at most once a minute", () => {
    expect(updateCheckDelay(1_000_000, Number.NEGATIVE_INFINITY)).toBe(0);
    expect(updateCheckDelay(1_000_000, 1_000_000 - 61_000)).toBe(0);
    expect(updateCheckDelay(1_000_000, 1_000_000 - 20_000)).toBe(40_000);
  });
});
