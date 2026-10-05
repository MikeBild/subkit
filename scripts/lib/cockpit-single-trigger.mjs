export function collectTriggers(root, content) {
  const LAYERS =
    '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper]';
  const ITEMS = '[data-action-scope], li, tr, [role="row"], [role="listitem"]';
  const scopes = [...root.querySelectorAll(ITEMS)];
  const clean = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  const nameOf = (node) => {
    const label = clean(node.getAttribute("aria-label"));
    if (label) return label;
    const ids = clean(node.getAttribute("aria-labelledby"));
    if (ids)
      return clean(
        ids
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
    const labelled = clean([...(node.labels ?? [])].map((label) => label.textContent).join(" "));
    if (labelled) return labelled;
    return clean(node.innerText) || clean(node.textContent) || clean(node.getAttribute("title"));
  };
  const triggers = [];
  for (const node of root.querySelectorAll('button, a[href], [role="button"]')) {
    const layer = node.closest(LAYERS);
    if (layer && layer !== root && root.contains(layer)) continue;
    if (node.closest('[aria-hidden="true"], [inert]')) continue;
    if (content && node.matches(content)) continue;
    if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const item = node.closest(ITEMS);
    const scope = item && root.contains(item) && item !== root ? item : null;
    triggers.push({
      name: nameOf(node),
      href: node.tagName === "A" ? node.getAttribute("href") : null,
      testId: node.getAttribute("data-testid"),
      opens: node.getAttribute("data-opens"),
      scopeKind: scope
        ? (scope.getAttribute("data-action-scope") ?? scope.getAttribute("role") ?? scope.localName)
        : null,
      scope: scope ? scopes.indexOf(scope) : null,
    });
  }
  return triggers;
}

function onePerItem(group) {
  const [first] = group;
  if (group.some((trigger) => trigger.scope === null)) return false;
  if (group.some((trigger) => trigger.scopeKind !== first.scopeKind)) return false;
  return new Set(group.map((trigger) => trigger.scope)).size === group.length;
}

function groupBy(triggers, key) {
  const groups = new Map();
  for (const trigger of triggers) {
    const value = key(trigger);
    if (!value) continue;
    groups.set(value, [...(groups.get(value) ?? []), trigger]);
  }
  return [...groups.entries()];
}

export function duplicateTriggers(triggers) {
  const where = (group) => group.map((trigger) => trigger.testId ?? "(no test id)").join(", ");
  const found = [];
  for (const [name, group] of groupBy(triggers, (trigger) => trigger.name.toLowerCase()))
    if (group.length > 1 && !onePerItem(group))
      found.push(`"${name}" is offered ${group.length} times (${where(group)})`);
  for (const [href, group] of groupBy(triggers, (trigger) => trigger.href))
    if (group.length > 1 && !onePerItem(group))
      found.push(`${group.length} links lead to ${href} (${where(group)})`);
  return found;
}

export async function assertSingleTriggers(
  page,
  where,
  { root = '[data-family-surface="detail"]', approvalOpeners, content = null } = {},
) {
  const view = page.locator(root);
  if ((await view.count()) !== 1) throw new Error(`${where}: there is no single view "${root}"`);
  let triggers = await view.evaluate(collectTriggers, content);
  for (let attempt = 0; triggers.length === 0 && attempt < 20; attempt++) {
    await page.waitForTimeout(250);
    triggers = await view.evaluate(collectTriggers, content);
  }
  if (triggers.length === 0)
    throw new Error(`${where}: no trigger is visible — the check ran behind a layer`);
  const unnamed = triggers.filter((trigger) => !trigger.name);
  if (unnamed.length > 0)
    throw new Error(
      `${where}: ${unnamed.length} trigger(s) have no name (${unnamed.map((trigger) => trigger.testId).join(", ")})`,
    );
  const duplicates = duplicateTriggers(triggers);
  if (duplicates.length > 0)
    throw new Error(`${where}: an action stands more than once — ${duplicates.join("; ")}`);
  const openers = triggers.filter((trigger) => trigger.opens === "workflow-approval");
  if (approvalOpeners === undefined ? openers.length > 1 : openers.length !== approvalOpeners)
    throw new Error(
      `${where}: the approval dialog can be opened from ${openers.length} element(s)${
        approvalOpeners === undefined ? "" : `, not ${approvalOpeners}`
      } (${openers.map((trigger) => `${trigger.testId} "${trigger.name}"`).join(", ")})`,
    );
}

export const TRANSCRIPT = {
  root: '[data-testid="chat-transcript"]',
  content: '[data-testid="message-link"]',
};

export const PATTERN_MIGRATED_VIEWS = [
  "",
  "chat",
  "workflows",
  "connectors",
  "knowledge",
  "skills",
  "files",
  "knowledge/$id",
  "skills/$id",
  "audit",
  "usage",
  "people",
  "api-access",
  "settings",
  "settings?tab=notifications",
  "workflows/$id",
  "connectors/$id",
  "?runs=all",
  "?run=$id",
  "files/$id",
];

export function patternMigratedView(route) {
  const general = route
    .replace(/^(workflows|connectors|knowledge|skills|files)\/[^/?#]+$/, "$1/$id")
    .replace(/^\?run=[^&#]+$/, "?run=$id");
  return PATTERN_MIGRATED_VIEWS.includes(general) ? general : null;
}

export function isSheetView(view) {
  return view === "?runs=all" || view === "?run=$id" || view === "files/$id";
}

export function patternViewRoot(view) {
  if (isSheetView(view)) return "[data-sheet-size]";
  return view.includes("/") ? '[data-family-surface="detail"]' : "main[data-page-kind]";
}
