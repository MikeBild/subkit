import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  getRecipePackOperation,
  getTemplateRecipeOperation,
  listTemplateRecipesOperation,
} from "../../../api/operations/connector-recipes.ts";
import {
  createConnectorFromTemplateOperation,
  createConnectorTemplateOperation,
  deleteConnectorTemplateOperation,
  listConnectorTemplatesOperation,
  matchConnectorTemplateUrlOperation,
  storeTemplateOAuthCredentialsOperation,
} from "../../../api/operations/connector-templates.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerImportRoutes } from "./import-spec.ts";

export function registerConnectorTemplateRoutes(app: OpenAPIHono<AppEnv>): void {
  registerImportRoutes(app);
  toHonoRoute(app, matchConnectorTemplateUrlOperation);
  toHonoRoute(app, listConnectorTemplatesOperation);
  toHonoRoute(app, createConnectorTemplateOperation);
  toHonoRoute(app, deleteConnectorTemplateOperation);
  toHonoRoute(app, listTemplateRecipesOperation);
  toHonoRoute(app, getTemplateRecipeOperation);
  toHonoRoute(app, getRecipePackOperation);
  toHonoRoute(app, storeTemplateOAuthCredentialsOperation);
  toHonoRoute(app, createConnectorFromTemplateOperation);
}
