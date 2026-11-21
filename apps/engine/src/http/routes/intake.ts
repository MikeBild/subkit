import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  createIntakeItemOperation,
  deleteIntakeItemOperation,
  getIntakeDefaultCategoryOperation,
  getIntakeItemOperation,
  listIntakeItemsOperation,
  listIntakeMentionItemsOperation,
  patchIntakeItemOperation,
  setIntakeDefaultCategoryOperation,
} from "../../api/operations/intake.ts";
import { createIntakeFileItemOperation } from "../../api/operations/intake-files.ts";
import {
  confirmIntakeProposalOperation,
  createIntakeProposalOperation,
  getIntakeProposalOperation,
  listIntakeProposalsOperation,
  rejectIntakeProposalOperation,
  reviseIntakeProposalOperation,
} from "../../api/operations/intake-proposals.ts";
import type { AppEnv } from "../openapi.ts";

export function registerIntakeRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, getIntakeDefaultCategoryOperation);
  toHonoRoute(app, setIntakeDefaultCategoryOperation);
  toHonoRoute(app, listIntakeItemsOperation);
  toHonoRoute(app, listIntakeMentionItemsOperation);
  toHonoRoute(app, createIntakeItemOperation);
  toHonoRoute(app, createIntakeFileItemOperation);
  toHonoRoute(app, getIntakeItemOperation);
  toHonoRoute(app, patchIntakeItemOperation);
  toHonoRoute(app, deleteIntakeItemOperation);
  toHonoRoute(app, listIntakeProposalsOperation);
  toHonoRoute(app, createIntakeProposalOperation);
  toHonoRoute(app, getIntakeProposalOperation);
  toHonoRoute(app, reviseIntakeProposalOperation);
  toHonoRoute(app, confirmIntakeProposalOperation);
  toHonoRoute(app, rejectIntakeProposalOperation);
}
