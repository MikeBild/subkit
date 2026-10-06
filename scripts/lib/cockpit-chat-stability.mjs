const ANSWER_LEAD = "Stable answer lead sentence.";
const ANSWER = `${ANSWER_LEAD} The transcript keeps every message where it is.\n\n- first point\n- second point\n\n\`\`\`json\n{ "rows": 412 }\n\`\`\`\n\nThe answer ends with **bold** words and a [link](https://example.com).`;
const SHIFT_LIMIT = 0.02;

function tokens(text) {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

async function installStream(page) {
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (url, options) => {
      const path = new URL(String(url), window.location.href).pathname;
      if (
        options?.method === "POST" &&
        (path.endsWith("/messages") || path === "/v1/conversations")
      ) {
        const stream = new ReadableStream({
          start(controller) {
            window.chatStream = controller;
          },
        });
        return Promise.resolve(
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
        );
      }
      return original(url, options);
    };
  });
}

async function startProbe(page, lead, userText) {
  await page.evaluate(
    ({ lead, userText }) => {
      const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
      const items = new Set(
        [...viewport.querySelectorAll('[data-slot="message-scroller-item"]')].filter(
          (item) => (item.textContent ?? "").trim().length > 0,
        ),
      );
      const probe = {
        initial: items.size,
        removed: 0,
        answerGaps: 0,
        userGaps: 0,
        answerSeen: false,
        userSeen: false,
        shift: 0,
        frames: 0,
        running: true,
      };
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.removedNodes)
            for (const item of items)
              if (node === item || node.contains?.(item)) probe.removed += 1;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const shifts = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (entry.sources.some((source) => source.node && viewport.contains(source.node)))
            probe.shift += entry.value;
      });
      shifts.observe({ type: "layout-shift", buffered: false });
      const sample = () => {
        if (!probe.running) return;
        probe.frames += 1;
        const text =
          document.querySelector('[data-slot="message-scroller-viewport"]')?.textContent ?? "";
        if (lead) {
          if (text.split(lead).length > 2) probe.answerTwice += 1;
          const present = text.includes(lead);
          if (present) probe.answerSeen = true;
          else if (probe.answerSeen) probe.answerGaps += 1;
        }
        if (userText) {
          const present = text.includes(userText);
          if (present) probe.userSeen = true;
          else if (probe.userSeen) probe.userGaps += 1;
        }
        const raw = getComputedStyle(viewport).getPropertyValue("--scroll-fade-b");
        const factor = raw.match(/\(([\d.e-]+) \*/);
        const fade = factor ? Number(factor[1]) > 0.05 : /min\(/.test(raw);
        const content = document.querySelector('[data-testid="page-content"]');
        if (content) {
          const dimmed =
            Number.parseFloat(getComputedStyle(content).opacity) < 0.99 ||
            content.getAnimations().some((animation) => animation.playState === "running");
          if (dimmed) probe.pageDimmed += 1;
        }
        if (probe.lastFade !== undefined && fade !== probe.lastFade) probe.fadeFlips += 1;
        probe.lastFade = fade;
        if (fade) probe.fadeFrames += 1;
        requestAnimationFrame(sample);
      };
      Object.assign(probe, { fadeFlips: 0, fadeFrames: 0, answerTwice: 0, pageDimmed: 0 });
      requestAnimationFrame(sample);
      window.stabilityProbe = {
        stop: () => {
          probe.running = false;
          observer.disconnect();
          shifts.disconnect();
          const detached = [...items].filter((item) => !item.isConnected).length;
          const { running, lastFade, ...numbers } = probe;
          return { ...numbers, detached, shift: Math.round(probe.shift * 10_000) / 10_000 };
        },
      };
    },
    { lead, userText },
  );
}

const stopProbe = (page) => page.evaluate(() => window.stabilityProbe.stop());

function judge(numbers, { answer, user, typing }) {
  const failures = [];
  if (numbers.removed > 0 || numbers.detached > 0)
    failures.push(
      `${numbers.removed} removal(s) of already-rendered messages, ${numbers.detached} left detached`,
    );
  if (numbers.shift > SHIFT_LIMIT)
    failures.push(`layout shift ${numbers.shift} exceeds ${SHIFT_LIMIT}`);
  if (answer && !numbers.answerSeen) failures.push("the streamed answer never showed");
  if (numbers.answerGaps > 0)
    failures.push(`the answer vanished for ${numbers.answerGaps} frame(s) after it showed`);
  if (user && !numbers.userSeen) failures.push("the sent message never showed");
  if (numbers.userGaps > 0)
    failures.push(`the sent message vanished for ${numbers.userGaps} frame(s) after it showed`);
  if (numbers.answerTwice > 0)
    failures.push(`the answer showed twice for ${numbers.answerTwice} frame(s)`);
  if (numbers.fadeFrames > 0)
    failures.push(`the bottom fade covered the newest line for ${numbers.fadeFrames} frame(s)`);
  if (numbers.pageDimmed > 0)
    failures.push(`the whole page faded for ${numbers.pageDimmed} frame(s)`);
  if (typing && numbers.refetches > 0)
    failures.push(`typing read the conversation ${numbers.refetches} time(s)`);
  return failures;
}

export async function verifyChatStability(page, stand, conversation, locale, label) {
  const de = locale === "de";
  await stand.visit(page, `chat/${conversation.id}`);
  await page.getByTestId("chat-composer-input").waitFor();
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const state = { turn: null, history: original.messages };
  const failures = [];
  const record = (phase, numbers, expect) => {
    console.log(`${label}/${phase} ${JSON.stringify(numbers)}`);
    for (const failure of judge(numbers, expect)) failures.push(`${phase}: ${failure}`);
  };
  let reads = 0;
  let lastRead = Date.now();
  const detailPattern = `**/v1/conversations/${conversation.id}`;
  const detail = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads += 1;
    lastRead = Date.now();
    const turn = state.turn
      ? [
          {
            id: "stability-user",
            role: "user",
            model: null,
            created_at: "2026-08-10T09:10:00.000Z",
            parts: [{ type: "text", text: state.turn }],
          },
          {
            id: "stability-answer",
            role: "assistant",
            model: "provider/model-v1",
            created_at: "2026-08-10T09:10:05.000Z",
            parts: [{ type: "text", text: ANSWER }],
          },
        ]
      : [];
    await new Promise((resolve) => setTimeout(resolve, 400));
    return route
      .fulfill({
        json: { ...original, messages: [...state.history, ...turn] },
      })
      .catch(() => {});
  };
  const emit = (event, data) =>
    page.evaluate(
      ({ event, data }) =>
        window.chatStream.enqueue(
          new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        ),
      { event, data },
    );
  const composer = () => page.getByTestId("chat-composer-input");
  const turn = async (where, text) => {
    await composer().click();
    reads = 0;
    await startProbe(page, null, null);
    await page.keyboard.type(text, { delay: 10 });
    const typing = { ...(await stopProbe(page)), refetches: reads };
    record(`${where}/typing`, typing, { typing: true });
    reads = 0;
    await startProbe(page, ANSWER_LEAD, text);
    await page.getByTestId("chat-composer-submit").click();
    await page.waitForFunction(() => Boolean(window.chatStream));
    if (where === "new")
      await emit("conversation_started", { type: "conversation_started", conversation });
    for (const token of tokens(ANSWER)) {
      await emit("message", { type: "text_delta", text: token });
      await page.waitForTimeout(15);
    }
    if (where === "existing") {
      const stale = 15_500 - (Date.now() - lastRead);
      if (stale > 0) await page.waitForTimeout(stale);
      const before = reads;
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      for (let wait = 0; wait < 20 && reads === before; wait += 1) await page.waitForTimeout(25);
      if (reads === before) failures.push(`${where}: a focus did not read the conversation`);
    }
    state.turn = text;
    await emit("outcome", { conversation, status: "active" });
    await page.evaluate(() => {
      window.chatStream.close();
      window.chatStream = null;
    });
    await page.getByTestId("chat-activity").waitFor({ state: "hidden" });
    await page.waitForTimeout(1_000);
    const streaming = { ...(await stopProbe(page)), refetches: reads };
    record(`${where}/answer`, streaming, { answer: true, user: true });
  };
  await page.route(detailPattern, detail);
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    await page.getByTestId("chat-transcript").getByText(state.history[0].parts[0].text).waitFor();
    await installStream(page);
    await turn(
      "existing",
      de
        ? "Bitte prüfe den Monatsreport erneut und nenne mir jede Abweichung gegenüber dem Vormonat, sortiert nach Kunde, mit Betrag, Ursache und dem Schritt, der sie eingeführt hat, damit ich sie mit dem Team besprechen kann."
        : "Please check the monthly report again and name every deviation from the previous month, sorted by customer, with amount, cause and the step that introduced it, so I can discuss it with the team.",
    );
    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    await viewport.hover();
    await page.mouse.wheel(0, -1_500);
    await page.waitForTimeout(300);
    const fadeAbove = await viewport.evaluate((el) =>
      /min\(/.test(getComputedStyle(el).getPropertyValue("--scroll-fade-b")),
    );
    if (!fadeAbove) failures.push("reading history: the bottom fade no longer marks text below");
    Object.assign(state, { turn: null, history: [] });
    await stand.visit(page, "chat/new");
    await composer().waitFor();
    await installStream(page);
    await turn("new", de ? "Lege einen neuen Bericht an" : "Create a new report");
    const entered = await page.evaluate(async () => {
      const content = document.querySelector('[data-testid="page-content"]');
      const seen = { animated: false };
      const watch = () => {
        if (content?.getAnimations().length) seen.animated = true;
        if (!seen.done) requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
      window.history.pushState(window.history.state, "", "/cockpit/workflows");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      seen.done = true;
      return seen.animated;
    });
    if (!entered) failures.push("moving to another page no longer eases the page in");
  } finally {
    await page.unroute(detailPattern, detail);
  }
  if (failures.length > 0) throw new Error(`${label}: the chat flickers — ${failures.join("; ")}`);
}
