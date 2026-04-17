// Cross-surface API contract.
//
// The spine: `common-schemas.ts` hosts the Zod shapes every HTTP route
// and MCP capability share (error envelope, pagination query, `{id}`
// URL parameter). Per-entity schemas live with their owning subsystem
// (see `http/routes/identity/schemas.ts`, `conversations/`, `skills/`,
// etc.) but ANY schema referenced by more than one subsystem belongs
// here.

export {
  ErrorSchema,
  IdParam,
  PaginationQuery,
  paginatedResponse,
} from "./common-schemas.ts";
