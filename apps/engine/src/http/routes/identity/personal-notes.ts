import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  archivePersonalNoteOperation,
  confirmPersonalNoteOperation,
  exportPersonalNotesOperation,
  forgetPersonalNoteOperation,
  getPersonalNoteOperation,
  listPersonalNotesOperation,
  restorePersonalNoteOperation,
  sharePersonalNoteOperation,
  toHonoRoute,
  updatePersonalNoteOperation,
} from "../../../api/index.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerPersonalNotesRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listPersonalNotesOperation);
  toHonoRoute(app, exportPersonalNotesOperation);
  toHonoRoute(app, getPersonalNoteOperation);
  toHonoRoute(app, updatePersonalNoteOperation);
  toHonoRoute(app, confirmPersonalNoteOperation);
  toHonoRoute(app, archivePersonalNoteOperation);
  toHonoRoute(app, restorePersonalNoteOperation);
  toHonoRoute(app, forgetPersonalNoteOperation);
  toHonoRoute(app, sharePersonalNoteOperation);
}
