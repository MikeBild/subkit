const OPEN_STATES = ["delayed-open", "instant-open"];
const TRIGGER = "[data-tooltip-trigger]";

function recordUnpromptedTooltips(trigger) {
  const name = (element) =>
    element?.getAttribute("data-testid") ??
    element?.querySelector("[data-testid]")?.getAttribute("data-testid") ??
    element?.getAttribute("aria-label") ??
    element?.tagName?.toLowerCase() ??
    "nothing";
  let tabbed = false;
  document.addEventListener(
    "keydown",
    (event) => {
      tabbed = event.key === "Tab";
      if (tabbed) setTimeout(() => (tabbed = false), 0);
    },
    true,
  );
  document.addEventListener("tooltip.open", () => {
    if (document.querySelector(`${trigger}:hover, ${trigger} :hover`)) return;
    if (tabbed) return;
    const active = document.activeElement;
    const breach = {
      trigger: name(active?.closest(trigger) ?? active),
      at: `${window.location.pathname}${window.location.search}`,
    };
    window.__skTooltipBreaches = [...(window.__skTooltipBreaches ?? []), breach];
    window.__skTooltipBreach?.(breach);
  });
}

export async function watchUnpromptedTooltips(context) {
  const breaches = [];
  await context.exposeBinding("__skTooltipBreach", (_source, breach) => {
    breaches.push(breach);
  });
  await context.addInitScript(recordUnpromptedTooltips, TRIGGER);
  return {
    assertNone(where) {
      if (breaches.length === 0) return;
      const found = breaches.splice(0);
      throw new Error(
        `${where}: ${found.length} tooltip(s) opened without hover or a Tab to it — ${found
          .slice(0, 3)
          .map((breach) => `${breach.trigger} at ${breach.at}`)
          .join(" | ")}`,
      );
    },
  };
}

export async function assertTabOpensTooltip(page, where, within) {
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press("Tab");
    const reached = await page.evaluate(
      ({ trigger, scope }) => {
        const active = document.activeElement;
        if (!active?.matches(trigger) || !active.closest(scope)) return null;
        return active.getAttribute("data-testid") ?? active.getAttribute("aria-label") ?? "";
      },
      { trigger: TRIGGER, scope: within },
    );
    if (reached === null) continue;
    const shown = await page
      .locator('[data-slot="tooltip-content"]')
      .first()
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) throw new Error(`${where}: a Tab to ${reached} does not show its tooltip`);
    await page.keyboard.press("Escape");
    return;
  }
  throw new Error(`${where}: sixty Tabs never reach a tooltip inside ${within}`);
}

export async function assertNoTooltipWithoutHover(page, where) {
  await page.waitForTimeout(700);
  const open = await page.evaluate(
    ({ states, trigger }) => [
      ...(window.__skTooltipBreaches ?? []).map((breach) => breach.trigger),
      ...[...document.querySelectorAll(trigger)]
        .filter((element) => states.includes(element.getAttribute("data-state") ?? ""))
        .filter(
          (element) =>
            !element.matches(":hover, :focus") && !element.querySelector(":hover, :focus"),
        )
        .map(
          (element) =>
            element.getAttribute("data-testid") ??
            element.querySelector("[data-testid]")?.getAttribute("data-testid") ??
            element.getAttribute("aria-label") ??
            "unnamed trigger",
        ),
    ],
    { states: OPEN_STATES, trigger: TRIGGER },
  );
  if (open.length > 0)
    throw new Error(`${where}: a tooltip opened without hover or a Tab to it — ${open[0]}`);
}
