import { json } from "./cockpit-journey-fixtures.mjs";

export async function verifyChatStarterCards(page, stand, mockApi) {
  const workflowId = "018f4b4a-6d33-7b3a-9c2d-123456789ad2";
  const workflowName = "Berichtsworkflow";
  const sourceSlug = "lokales-betriebshandbuch";
  const sourceName = "Lokales Betriebshandbuch";
  const failurePrompt = "Warum schlägt Berichtsworkflow fehl?";
  const knowledgePrompt = "Fasse zusammen, was in der Quelle „Lokales Betriebshandbuch“ steht.";
  const apiRequests = [];
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (request.method() !== "GET") return route.fallback();
    if (url.pathname === "/v1/attention")
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          if (response.status !== 200 || typeof response.body !== "string")
            throw new Error("attention fixture has no successful mock response");
          const body = JSON.parse(response.body);
          const failingWorkflow = body.items.find(
            (item) => item.class === "failing" && item.subject?.kind === "workflow",
          );
          if (!failingWorkflow) throw new Error("attention fixture has no failing workflow");
          body.items = [
            {
              ...failingWorkflow,
              id: `workflow:${workflowId}`,
              counts: { ...failingWorkflow.counts, consecutive_failures: 2 },
              subject: { kind: "workflow", id: workflowId, name: workflowName },
            },
          ];
          await route.fulfill({ ...response, body: JSON.stringify(body) });
        },
      });
    if (url.pathname === "/v1/workflows" && url.searchParams.get("limit") === "1")
      return json(route, { items: [], total: 0, categories: [] });
    if (url.pathname === "/v1/knowledge-sources")
      return json(route, {
        items: [{ slug: sourceSlug, name: sourceName }],
        total: 1,
      });
    if (url.pathname === "/v1/recipe-packs/solutions") return json(route, { recipes: [] });
    if (url.pathname === "/v1/intake/default-category") return json(route, { category: "inbox" });
    if (url.pathname === "/v1/categories") return json(route, { categories: [] });
    return route.fallback();
  };
  await page.route("**/v1/**", handler);
  try {
    await stand.visit(page, "chat/new");
    const starters = page.getByTestId("chat-starters");
    await starters.waitFor({ state: "visible" }).catch(async (error) => {
      const body = (await page.locator("body").innerText()).slice(0, 1000);
      throw new Error(
        `chat starter cards did not render at ${page.url()}; API requests: ${apiRequests.join(", ")}; page: ${body}`,
        { cause: error },
      );
    });
    const failing = page.getByTestId(`chat-starter-failing-${workflowId}`);
    const knowledge = page.getByTestId(`chat-starter-knowledge-${sourceSlug}`);
    await failing.waitFor({ state: "visible" });
    await knowledge.waitFor({ state: "visible" });
    if (
      (await failing.innerText()).trim() !==
      `Warum schlug etwas fehl?\n${workflowName} · 2 Fehlschläge in Folge`
    )
      throw new Error("the failing workflow starter does not show its consecutive failure count");
    if ((await knowledge.innerText()).trim() !== `Was gilt im Betrieb?\nQuelle · ${sourceName}`)
      throw new Error("the knowledge starter does not show its selected source");
    const composer = page.getByTestId("chat-composer-input");
    await failing.click();
    if ((await composer.inputValue()).trim() !== failurePrompt)
      throw new Error("the failing workflow starter did not fill its corresponding prompt");
    await knowledge.click();
    if ((await composer.inputValue()).trim() !== knowledgePrompt)
      throw new Error("the knowledge starter did not fill its corresponding prompt");
    if (!new URL(page.url()).pathname.endsWith("/chat/new") || !(await starters.isVisible()))
      throw new Error(
        "selecting a starter submitted a chat turn instead of only filling the composer",
      );
  } finally {
    await page.unroute("**/v1/**", handler);
  }
}
