// An action exists once per view (apps/cockpit/UI-UX.md, "Action hierarchy").
//
// A workflow page once offered "Jetzt freigeben" beside its title, again in
// the automation panel below it, and a third time as a "Zur Freigabe" link in
// the call block. Each of the three was correct on its own; together they made
// a reader ask which one is the real one. The assertions that existed counted
// test ids — and every one of the three had its own.
//
// This check reads the page the way a reader does: by what the triggers are
// called and where they lead, not by how the code names them.
//
// - No two visible triggers (button, link, role=button) share an accessible
//   name, and no two links lead to the same address.
// - The one exemption is a trigger that acts on its own item in a list of
//   items: the row of a run in a list of runs, the copy button of each fenced
//   block, "Details" on each approval, the repair of each refused step. An
//   item is a list or table row, or an element the markup marks with
//   `data-action-scope`; the same words in two DIFFERENT items of the same
//   kind are two actions. The same words twice in one item, or once inside an
//   item and once outside, are not.
// - The approval dialog is opened by at most one element (`data-opens`), and
//   by exactly as many as the caller says the state calls for.
//
// A link inside a message of a conversation is what the conversation wrote —
// content, like the text around it — and the caller of a transcript check
// names it as such (`TRANSCRIPT`).
//
// Menus, dialogs and popovers are layers of their own, not part of the view
// below them, and are left out — so a page is checked while none is open, and
// a dialog is checked by naming it as the view.

/**
 * Every trigger a reader can press under `root`. Runs IN THE BROWSER
 * (`locator.evaluate(collectTriggers)`): no imports, no closure.
 */
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
    // A switch or a checkbox is named by its `<label>`.
    const labelled = clean([...(node.labels ?? [])].map((label) => label.textContent).join(" "));
    if (labelled) return labelled;
    // `innerText` is empty for content the browser has not laid out yet
    // (`content-visibility`); the text is in the document all the same.
    return clean(node.innerText) || clean(node.textContent) || clean(node.getAttribute("title"));
  };
  const triggers = [];
  for (const node of root.querySelectorAll('button, a[href], [role="button"]')) {
    // A layer inside the view is another view. The view itself may be one.
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

/** The same words (or address) in different items of one kind: one action per item. */
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

/** What breaks the rule among `triggers`, as sentences. Empty: nothing does. */
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

/**
 * Fail when the view under `root` offers an action more than once.
 *
 * `approvalOpeners` is how many elements must open the approval dialog in the
 * state the caller put the page in — 1 where an approval is the next step, 0
 * where it is not. Left out, the check is "at most one".
 */
export async function assertSingleTriggers(
  page,
  where,
  { root = '[data-family-surface="detail"]', approvalOpeners, content = null } = {},
) {
  const view = page.locator(root);
  if ((await view.count()) !== 1) throw new Error(`${where}: there is no single view "${root}"`);
  const triggers = await view.evaluate(collectTriggers, content);
  // A page behind an open dialog is hidden from this check entirely: it would
  // pass for having nothing to compare.
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

/**
 * A chat's transcript as a view: the links a message's own text carries are
 * content, not actions of the page.
 */
export const TRANSCRIPT = {
  root: '[data-testid="chat-transcript"]',
  content: '[data-testid="message-link"]',
};

/**
 * The views already built from the pattern set (spec §6). The heading and
 * alignment rules of §6 rule 3 and the single-trigger rule of §6 rule 2 run on
 * each of them; the list grows as the page tracks migrate views, until it
 * covers every view. `$id` stands for the record the sweep opens.
 */
export const PATTERN_MIGRATED_VIEWS = [
  "chat",
  "workflows",
  "connectors",
  "knowledge",
  "skills",
  "files",
  "audit",
  "usage",
  "people",
  "api-access",
  "settings",
  "settings?tab=benachrichtigungen",
  "workflows/$id",
  // The run sheets: all runs (wide) and one run (default width).
  "?runs=all",
  "?run=$id",
  // One file: a sheet over the Dateien list, at the file's own address.
  "files/$id",
];

/** The migrated view a visited route is, or null. Record ids read as `$id`. */
export function patternMigratedView(route) {
  const general = route
    .replace(/^(workflows|connectors|knowledge|skills|files)\/[^/?#]+$/, "$1/$id")
    .replace(/^\?run=[^&#]+$/, "?run=$id");
  return PATTERN_MIGRATED_VIEWS.includes(general) ? general : null;
}

/** A migrated view that is an overlay: its rules run on the open sheet, not the page. */
export function isSheetView(view) {
  return view === "?runs=all" || view === "?run=$id" || view === "files/$id";
}

/**
 * The single-trigger root of a migrated view: the open sheet for the run
 * sheets, the record for a detail page, the page for every other view.
 */
export function patternViewRoot(view) {
  if (isSheetView(view)) return "[data-sheet-size]";
  return view.includes("/") ? '[data-family-surface="detail"]' : "main[data-page-kind]";
}
