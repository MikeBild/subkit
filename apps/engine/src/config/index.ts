export { configurationSweepLeaves, sampleConfigLeaf } from "./__tests__/leaf-samples.ts";
export type { DeploymentMode } from "./deployment-mode.ts";
export { currentDeploymentMode } from "./deployment-mode.ts";
export {
  _resetConfigForTests,
  getConfig,
  getDiagnostics,
  installRuntimeConfig,
  isConfigLoaded,
  loadConfig,
  modelSettingMismatch,
  RestartRequiredError,
  ScopeViolationError,
  setConfigKey,
  ValidationError,
} from "./loader.ts";
export {
  bindProcessBindings,
  PROCESS_BINDING_PATHS,
  processBindingRefusal,
} from "./process-bindings.ts";
export type {
  AuthProviderConfig,
  Config,
  OidcBearerProviderConfig,
  ProductConfig,
} from "./schema.ts";
export {
  ConfigSchema,
  DatabaseConfigSchema,
  DESKTOP_MIN_VERSION_DEFAULT,
  isBrowserLoginProvider,
  ModelPriceSchema,
} from "./schema.ts";
export type { ConfigLeaf } from "./walk.ts";
export { dottedPath, findLeafByPath, leafSchemaMeta, listConfigLeaves, setDeep } from "./walk.ts";
