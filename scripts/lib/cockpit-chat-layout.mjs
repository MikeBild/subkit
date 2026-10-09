export const CHAT_EDGE_TOLERANCE = 1;
export const CHAT_RHYTHM = { inMessage: 10, betweenMessages: 24 };

export function measureChatLayout() {
  const visible = (element) =>
    element instanceof Element &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    element.getBoundingClientRect().width > 0;
  const round = (value) => Math.round(value * 10) / 10;
  const textLeft = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent.trim() && visible(node.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const node = walker.nextNode();
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const first = [...range.getClientRects()].find((rect) => rect.width > 0);
    return first ? round(first.left) : null;
  };
  const glyphLeft = (element) => {
    const svg = element.querySelector("svg");
    return svg ? round(svg.getBoundingClientRect().left) : textLeft(element);
  };
  const rect = (element) => element.getBoundingClientRect();
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const one = (selector, root = document) => all(selector, root)[0] ?? null;

  const list = [];
  const listBoxes = [];
  const listRight = [];
  const panel = one('[data-testid="chat-list-panel"]');
  if (panel) {
    const middle = rect(panel).left + rect(panel).width / 2;
    const boxed = (name, element) => {
      listBoxes.push({ name, edge: round(rect(element).left) });
      listRight.push({ name, edge: round(rect(element).right) });
    };
    const trigger = one('[data-testid="sidebar-trigger"]', panel);
    if (trigger) {
      list.push({ name: "list toggle glyph", edge: glyphLeft(trigger) });
      listBoxes.push({ name: "list toggle", edge: round(rect(trigger).left) });
    } else {
      const heading = one("h1", panel);
      if (heading)
        (window.innerWidth < 768 ? list : listBoxes).push({
          name: "list title",
          edge: textLeft(heading),
        });
    }
    const fresh = one('[data-testid="conversation-new"]', panel);
    if (fresh && rect(fresh).left < middle) boxed("new conversation", fresh);
    for (const item of all('[data-testid^="conversation-item-"]', panel)) {
      const id = item.dataset.testid;
      if (/-item-\d+$/.test(id)) boxed(id, item);
      else if (id.endsWith("-title")) list.push({ name: `${id} text`, edge: textLeft(item) });
    }
    const hidden = one('[data-testid="conversation-toggle-hidden"]', panel);
    if (hidden) {
      list.push({ name: "hidden toggle text", edge: textLeft(hidden) });
      boxed("hidden toggle", hidden);
    }
  }

  const left = [];
  const right = [];
  const title = one('[data-testid="chat-title"]');
  if (title) left.push({ name: "title text", edge: textLeft(title) });
  const headButtons = all('[data-testid="chat-conversation-head"] button');
  const lastButton = headButtons[headButtons.length - 1];
  if (lastButton) right.push({ name: "last header action", edge: round(rect(lastButton).right) });
  const summary = one('[data-testid="chat-summary"]');
  if (summary) {
    left.push({ name: "context line text", edge: textLeft(summary) });
    right.push({ name: "context line box", edge: round(rect(summary).right) });
  }
  const viewport = one('[data-slot="message-scroller-viewport"]');
  const view = viewport ? rect(viewport) : null;
  const onScreen = (element) => {
    if (!view || !visible(element)) return false;
    const box = rect(element);
    return box.bottom > view.top && box.top < view.bottom;
  };
  const messages = all('[data-cockpit-ui="chat-message"]').filter(onScreen);
  const cards = '[data-slot="card"], [data-slot="chat-card"], [data-slot="collapsible"]';
  const inMessage = [];
  for (const message of messages) {
    const id = message.dataset.testid;
    const role = message.querySelector(`[data-testid="${id}-role"]`);
    if (visible(role)) left.push({ name: `${id} role text`, edge: textLeft(role) });
    for (const text of message.querySelectorAll(`[data-testid^="${id}-text-"]`)) {
      if (!visible(text) || !/-text-\d+$/.test(text.dataset.testid)) continue;
      if (text.closest('[data-variant="question"]')) continue;
      left.push({ name: `${text.dataset.testid} text`, edge: textLeft(text) });
    }
    for (const bubble of message.querySelectorAll('[data-variant="question"]'))
      if (visible(bubble))
        left.push({ name: `${id} question box`, edge: round(rect(bubble).left) });
    for (const card of message.querySelectorAll(cards)) {
      if (!visible(card) || card.parentElement?.closest(cards)) continue;
      left.push({ name: `${id} card box`, edge: round(rect(card).left) });
      right.push({ name: `${id} card box`, edge: round(rect(card).right) });
    }
    const meta = message.querySelector(`[data-testid="${id}-metadata"]`);
    if (visible(meta)) left.push({ name: `${id} meta text`, edge: textLeft(meta) });
    const content = message.querySelector('[data-slot="message-content"]');
    const children = [...(content?.children ?? [])].filter(visible);
    for (let index = 1; index < children.length; index += 1)
      inMessage.push({
        name: `${id} child ${index - 1}→${index}`,
        gap: round(rect(children[index]).top - rect(children[index - 1]).bottom),
      });
  }
  const pills = one('[data-testid="chat-pills"]');
  if (pills) left.push({ name: "pills box", edge: round(rect(pills).left) });
  const composer = one('[data-testid="chat-composer"]');
  if (composer) {
    left.push({ name: "composer box", edge: round(rect(composer).left) });
    right.push({ name: "composer box", edge: round(rect(composer).right) });
  }

  const scrollerContent = one('[data-slot="message-scroller-content"]');
  const isEmpty = (item) => item.children.length === 0 && !item.textContent.trim();
  const shown = scrollerContent
    ? [...scrollerContent.children].filter((item) => getComputedStyle(item).display !== "none")
    : [];
  const items = shown.filter((item) => !isEmpty(item));
  const betweenMessages = [];
  for (let index = 1; index < items.length; index += 1) {
    const before = rect(items[index - 1]);
    const after = rect(items[index]);
    const style = getComputedStyle(items[index]);
    const previous = getComputedStyle(items[index - 1]);
    betweenMessages.push({
      name: `item ${index - 1}→${index}`,
      gap: round(
        after.top +
          Number.parseFloat(style.paddingTop) -
          (before.bottom - Number.parseFloat(previous.paddingBottom)),
      ),
    });
  }
  const emptyItems = shown.filter(isEmpty).map((item) => item.dataset.testid ?? "item");
  let summaryGap = null;
  if (summary && viewport) {
    const padding = Number.parseFloat(getComputedStyle(viewport).paddingTop);
    summaryGap = round(view.top + padding - rect(summary).bottom);
  }

  const clipped = [];
  for (const card of all(cards, viewport ?? document)) {
    if (card.parentElement?.closest(cards) || !onScreen(card)) continue;
    let clipper = card.parentElement;
    while (clipper && clipper !== document.body) {
      const style = getComputedStyle(clipper);
      if (
        style.contentVisibility === "auto" ||
        /paint|content|strict/.test(style.contain) ||
        style.overflowX !== "visible"
      )
        break;
      clipper = clipper.parentElement;
    }
    if (!clipper || clipper === document.body) continue;
    const style = getComputedStyle(clipper);
    const outer = rect(clipper);
    const pad = {
      left: outer.left + Number.parseFloat(style.borderLeftWidth),
      right: outer.right - Number.parseFloat(style.borderRightWidth),
      top: outer.top + Number.parseFloat(style.borderTopWidth),
      bottom: outer.bottom - Number.parseFloat(style.borderBottomWidth),
    };
    const box = rect(card);
    const ring = 1;
    if (
      box.left - ring < pad.left - 0.01 ||
      box.right + ring > pad.right + 0.01 ||
      box.top - ring < pad.top - 0.01 ||
      box.bottom + ring > pad.bottom + 0.01
    )
      clipped.push(card.dataset.testid ?? card.dataset.slot);
  }

  return {
    list,
    listBoxes,
    listRight,
    left,
    right,
    rhythm: { inMessage, betweenMessages, summaryGap, emptyItems },
    clipped,
  };
}

function spread(entries) {
  const edges = entries.map((entry) => entry.edge).filter((edge) => typeof edge === "number");
  return edges.length < 2 ? 0 : Math.max(...edges) - Math.min(...edges);
}

function describe(entries) {
  const byValue = new Map();
  for (const entry of entries) {
    const value = entry.edge ?? entry.gap;
    byValue.set(value, [...(byValue.get(value) ?? []), entry.name]);
  }
  return [...byValue]
    .map(([value, names]) =>
      names.length > 2
        ? `${names[0]} and ${names.length - 1} more=${value}`
        : `${names.join(", ")}=${value}`,
    )
    .join("; ");
}

async function measureWithList(page) {
  const trigger = page.locator('[data-testid="conversation-list-trigger"]');
  if (!(await trigger.isVisible())) return page.evaluate(measureChatLayout);
  const list = page.locator('[data-testid="conversation-list"]');
  const opened = !(await list.isVisible());
  if (opened) {
    await trigger.click();
    await list.waitFor({ state: "visible" });
  }
  const shape = await page.evaluate(measureChatLayout);
  if (opened) {
    await trigger.click();
    await list.waitFor({ state: "hidden" });
  }
  return shape;
}

export async function assertChatLayout(page, label, { openList = false } = {}) {
  const shape = openList ? await measureWithList(page) : await page.evaluate(measureChatLayout);
  const problems = [];
  if (spread(shape.list) > CHAT_EDGE_TOLERANCE)
    problems.push(`the conversation list's text starts at different x — ${describe(shape.list)}`);
  if (spread(shape.listBoxes) > CHAT_EDGE_TOLERANCE)
    problems.push(
      `the conversation list's controls start at different x — ${describe(shape.listBoxes)}`,
    );
  if (spread(shape.listRight) > CHAT_EDGE_TOLERANCE)
    problems.push(
      `the conversation list's controls end at different x — ${describe(shape.listRight)}`,
    );
  if (spread(shape.left) > CHAT_EDGE_TOLERANCE)
    problems.push(`the conversation column starts at different x — ${describe(shape.left)}`);
  if (spread(shape.right) > CHAT_EDGE_TOLERANCE)
    problems.push(`the conversation column ends at different x — ${describe(shape.right)}`);
  const off = (entries, token) =>
    entries.filter((entry) => Math.abs(entry.gap - token) > CHAT_EDGE_TOLERANCE);
  const inside = off(shape.rhythm.inMessage, CHAT_RHYTHM.inMessage);
  if (inside.length > 0)
    problems.push(
      `a message spaces its parts unlike ${CHAT_RHYTHM.inMessage}px — ${describe(inside)}`,
    );
  const between = off(shape.rhythm.betweenMessages, CHAT_RHYTHM.betweenMessages);
  if (between.length > 0)
    problems.push(
      `messages stand apart unlike ${CHAT_RHYTHM.betweenMessages}px — ${describe(between)}`,
    );
  if (shape.rhythm.emptyItems.length > 0)
    problems.push(`empty transcript rows take a gap — ${shape.rhythm.emptyItems.join(", ")}`);
  if (
    shape.rhythm.summaryGap !== null &&
    Math.abs(shape.rhythm.summaryGap - CHAT_RHYTHM.betweenMessages) > CHAT_EDGE_TOLERANCE
  )
    problems.push(
      `the context line stands ${shape.rhythm.summaryGap}px above the transcript, not ${CHAT_RHYTHM.betweenMessages}px`,
    );
  if (shape.clipped.length > 0)
    problems.push(`cards are drawn clipped — ${shape.clipped.join(", ")}`);
  if (problems.length > 0) throw new Error(`${label}: ${problems.join("; ")}`);
}
