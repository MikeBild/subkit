import type { MessageKey } from "../shared/i18n.ts";
import type { CheckResult, ConnectBridge, ConnectState } from "../shared/ipc.ts";
import { updateAction, updateStatus } from "../shared/updates.ts";

declare global {
  interface Window {
    subkitConnect: ConnectBridge;
  }
}

const bridge = window.subkitConnect;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element ${id}`);
  return found as T;
}

const ui = {
  connect: element<HTMLElement>("view-connect"),
  settings: element<HTMLElement>("view-settings"),
  notice: element<HTMLElement>("notice"),
  profiles: element<HTMLElement>("profiles"),
  profileList: element<HTMLUListElement>("profile-list"),
  form: element<HTMLFormElement>("server-form"),
  address: element<HTMLInputElement>("address"),
  check: element<HTMLButtonElement>("check"),
  status: element<HTMLElement>("status"),
  signIn: element<HTMLButtonElement>("sign-in"),
  cancel: element<HTMLButtonElement>("cancel-login"),
  launch: element<HTMLInputElement>("launch"),
  quietEnabled: element<HTMLInputElement>("quiet-enabled"),
  quietStart: element<HTMLInputElement>("quiet-start"),
  quietEnd: element<HTMLInputElement>("quiet-end"),
  language: element<HTMLSelectElement>("language"),
  updateStatus: element<HTMLElement>("update-status"),
  updateProgress: element<HTMLProgressElement>("update-progress"),
  updateAction: element<HTMLButtonElement>("update-action"),
  version: element<HTMLElement>("version"),
  toggle: element<HTMLButtonElement>("toggle-view"),
};

let state: ConnectState | null = null;
let checked: CheckResult | null = null;
let busy = false;
let lastPhase = "idle";

function text(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = state?.messages[key] ?? "";
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

function setStatus(message: string, tone: "ok" | "error" | "info" = "info"): void {
  ui.status.textContent = message;
  ui.status.dataset.tone = tone;
}

function describe(result: CheckResult): void {
  const vars = {
    version:
      result.status === "app-too-old" ? (state?.appVersion ?? "") : (result.serverVersion ?? ""),
    min: result.status === "app-too-old" ? (result.minAppVersion ?? "") : result.minServerVersion,
  };
  setStatus(text(`status.${result.status}`, vars), result.status === "compatible" ? "ok" : "error");
}

function renderProfiles(current: ConnectState): void {
  ui.profiles.hidden = current.profiles.length === 0;
  ui.profileList.replaceChildren(
    ...current.profiles.map((profile) => {
      const item = document.createElement("li");
      item.dataset.active = String(profile.active);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = profile.label;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "button";
      open.textContent = text(profile.signedIn ? "profiles.open" : "profiles.signIn");
      open.addEventListener("click", () => {
        if (profile.signedIn) return void bridge.openProfile(profile.id);
        ui.address.value = profile.serverOrigin;
        void signIn(profile.serverOrigin);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link";
      remove.textContent = text("profiles.remove");
      remove.setAttribute("aria-label", text("profiles.remove.label", { name: profile.label }));
      remove.addEventListener("click", () => void bridge.removeProfile(profile.id));
      item.append(name, open, remove);
      return item;
    }),
  );
}

function renderLogin(current: ConnectState): void {
  const { login } = current;
  const finished = login.phase === "idle" && lastPhase !== "idle" && lastPhase !== "failed";
  lastPhase = login.phase;
  if (finished) {
    checked = null;
    ui.address.value = "";
    setStatus("");
  }
  const waiting = login.phase === "waiting" || login.phase === "exchanging";
  ui.cancel.hidden = login.phase !== "waiting";
  ui.address.disabled = waiting || busy;
  ui.check.disabled = waiting || busy;
  ui.signIn.disabled = waiting || busy;
  ui.signIn.hidden = waiting || !(checked?.status === "compatible" || login.phase === "failed");
  if (login.phase === "waiting") setStatus(text("login.waiting"));
  else if (login.phase === "exchanging") setStatus(text("login.exchanging"));
  else if (login.phase === "failed") {
    if (!ui.address.value) ui.address.value = login.origin;
    setStatus(text(`login.${login.reason}`), "error");
  }
}

function renderUpdate(current: ConnectState): void {
  const { update } = current;
  const status = updateStatus(update, current.appVersion);
  ui.updateStatus.textContent = text(status.key, status.vars);
  ui.updateStatus.dataset.tone = update.phase === "failed" ? "error" : "info";
  ui.updateProgress.hidden = update.phase !== "downloading";
  ui.updateProgress.value = update.phase === "downloading" ? update.percent : 0;
  const action = updateAction(update);
  ui.updateAction.hidden = update.phase === "disabled";
  ui.updateAction.disabled = action === null;
  ui.updateAction.classList.toggle("primary", action === "restart");
  ui.updateAction.textContent = text(
    action === "restart" ? "updates.restart" : "tray.checkUpdates",
  );
}

function render(current: ConnectState): void {
  state = current;
  document.documentElement.lang = current.locale;
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = text(node.dataset.i18n as MessageKey);
  }
  const settings = current.view === "settings";
  ui.connect.hidden = settings;
  ui.settings.hidden = !settings;
  ui.toggle.textContent = text(settings ? "settings.back" : "settings.open");
  ui.version.textContent = text("app.version", { version: current.appVersion });
  ui.notice.hidden = current.notice === null;
  ui.notice.textContent = current.notice ? text(`notice.${current.notice.kind}`) : "";
  ui.launch.checked = current.settings.launchAtLogin;
  ui.quietEnabled.checked = current.settings.quietHours.enabled;
  ui.quietStart.value = current.settings.quietHours.start;
  ui.quietEnd.value = current.settings.quietHours.end;
  ui.quietStart.disabled = !current.settings.quietHours.enabled;
  ui.quietEnd.disabled = !current.settings.quietHours.enabled;
  ui.language.value = current.settings.locale;
  renderProfiles(current);
  renderLogin(current);
  renderUpdate(current);
}

async function run(task: () => Promise<CheckResult>): Promise<void> {
  if (busy || !state) return;
  busy = true;
  checked = null;
  setStatus(text("connect.checking"));
  renderLogin(state);
  try {
    checked = await task();
    describe(checked);
  } catch {
    setStatus(text("status.unreachable"), "error");
  } finally {
    busy = false;
    if (state) renderLogin(state);
  }
}

function signIn(address: string): Promise<void> {
  return run(() => bridge.login(address));
}

function saveQuietHours(): void {
  if (!ui.quietStart.value || !ui.quietEnd.value) return;
  void bridge.updateSettings({
    quietHours: {
      enabled: ui.quietEnabled.checked,
      start: ui.quietStart.value,
      end: ui.quietEnd.value,
    },
  });
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run(() => bridge.checkServer(ui.address.value)).then(() => {
    if (checked?.status === "compatible") ui.signIn.focus();
    else ui.address.focus();
  });
});
ui.address.addEventListener("input", () => {
  checked = null;
  if (state) renderLogin(state);
});
ui.signIn.addEventListener("click", () => void signIn(checked?.origin ?? ui.address.value));
ui.cancel.addEventListener("click", () => void bridge.cancelLogin());
ui.toggle.addEventListener(
  "click",
  () => void bridge.showView(state?.view === "settings" ? "connect" : "settings"),
);
ui.launch.addEventListener(
  "change",
  () => void bridge.updateSettings({ launchAtLogin: ui.launch.checked }),
);
ui.quietEnabled.addEventListener("change", saveQuietHours);
ui.quietStart.addEventListener("change", saveQuietHours);
ui.quietEnd.addEventListener("change", saveQuietHours);
ui.updateAction.addEventListener("click", () => void bridge.updateAction());
ui.language.addEventListener("change", () => {
  const value = ui.language.value;
  void bridge.updateSettings({ locale: value === "de" || value === "en" ? value : "system" });
});

bridge.onState(render);
void bridge.getState().then(render);
