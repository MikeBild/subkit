import { afterEach, expect, spyOn, test } from "bun:test";
import { exportPackage } from "./packages";

const fetchPreconnect = globalThis.fetch.preconnect;

function fetchWithPreconnect(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetchPreconnect });
}

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

function captureBodies(): unknown[] {
  const bodies: unknown[] = [];
  mocks.push(
    spyOn(globalThis, "fetch").mockImplementation(
      fetchWithPreconnect(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ file_id: "file_1" });
      }),
    ),
  );
  return bodies;
}

test("sends the selected kinds and categories", async () => {
  const bodies = captureBodies();
  await exportPackage({ kinds: ["workflow", "skill"], categories: ["crm", "billing"] });
  expect(bodies).toEqual([{ kinds: ["workflow", "skill"], categories: ["crm", "billing"] }]);
});

test("leaves out categories when none are selected", async () => {
  const bodies = captureBodies();
  await exportPackage({ kinds: ["file"], categories: [] });
  await exportPackage({ kinds: ["file"] });
  expect(bodies).toEqual([{ kinds: ["file"] }, { kinds: ["file"] }]);
});
