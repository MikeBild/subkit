// The restart offer on the settings page and how the page reads the engine
// while it restarts.

import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { translate } from "@/lib/i18n";
import {
  isStillRestarting,
  type RestartStatus,
  restartOffer,
  restartRefusalKey,
  restartSaveNote,
  restartSignsEveryoneOut,
  restartVerdict,
} from "@/pages/settings-restart-model";

const ADMIN = ["settings:read", "settings:write", "system:restart"];
const MEMBER = ["settings:read", "settings:write"];

function status(boot_id: string, active: number, saved: number): RestartStatus {
  return {
    boot_id,
    started_at: new Date(0).toISOString(),
    saved_revision: saved,
    active_revision: active,
    activation_status: active === saved ? "active" : "restart_required",
    restart_supervised: true,
    pending_restart_fields: [],
  };
}

describe("what the waiting-for-a-restart line offers", () => {
  test("a holder of system:restart with a supervisor gets the button", () => {
    expect(restartOffer(ADMIN, true)).toBe("restart");
  });

  test("without a declared supervisor — or an unread status — the manual way instead", () => {
    expect(restartOffer(ADMIN, false)).toBe("manual");
    expect(restartOffer(ADMIN, undefined)).toBe("manual");
    expect(translate("de", "settings.restartNow.manual")).toContain(
      "systemctl restart subkit-engine",
    );
    expect(translate("de", "settings.restartNow.manual")).toContain("Aufseher vorhanden");
  });

  test("without the permission: ask an admin, supervisor or not", () => {
    expect(restartOffer(MEMBER, true)).toBe("ask_admin");
    expect(restartOffer(MEMBER, false)).toBe("ask_admin");
    expect(translate("de", "settings.restartNow.askAdmin")).toBe(
      "Bitte einen Admin, SubKit neu zu starten.",
    );
  });

  test("the save dialog no longer claims the engine never restarts itself", () => {
    expect(translate("de", restartSaveNote("restart"))).toContain("Jetzt neu starten");
    expect(translate("de", restartSaveNote("ask_admin"))).toContain("Admin");
    expect(translate("de", restartSaveNote("manual"))).toContain("nicht selbst neu");
  });
});

describe("following the restart", () => {
  const OLD = "boot-old";

  test("no answer or a gateway/draining answer means still restarting; a refusal does not", () => {
    expect(isStillRestarting(new TypeError("Failed to fetch"))).toBe(true);
    expect(isStillRestarting(new ApiError(503, null, null))).toBe(true);
    expect(isStillRestarting(new ApiError(502, null, null))).toBe(true);
    expect(isStillRestarting(new ApiError(401, null, null))).toBe(false);
    expect(isStillRestarting(new ApiError(403, null, null))).toBe(false);
  });

  test("the same process is still draining; a new one decides", () => {
    expect(restartVerdict(OLD, null)).toBe("waiting");
    expect(restartVerdict(OLD, status(OLD, 4, 5))).toBe("waiting");
    expect(restartVerdict(OLD, status("boot-new", 5, 5))).toBe("restarted");
    expect(restartVerdict(OLD, status("boot-new", 4, 5))).toBe("not_activated");
  });

  test("each refusal reads as what it means", () => {
    expect(restartRefusalKey("not_supervised")).toBe("settings.restartNow.manual");
    expect(restartRefusalKey("nothing_pending")).toBe("settings.restartNow.refused.nothingPending");
    expect(restartRefusalKey("multiple_replicas")).toBe(
      "settings.restartNow.refused.multipleReplicas",
    );
    expect(restartRefusalKey("restart_in_progress")).toBe("settings.restartNow.refused.inProgress");
    expect(restartRefusalKey(null)).toBe("common.actionFailed");
  });

  test("a pending session secret signs everyone out, and the dialog must say so", () => {
    expect(restartSignsEveryoneOut(["auth.session.secret"])).toBe(true);
    expect(restartSignsEveryoneOut(["server.port"])).toBe(false);
  });
});
