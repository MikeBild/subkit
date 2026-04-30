// Placeholder substitution — public surface.
//
// Parser (pure, no I/O):
export {
  collectTokenNames,
  hasPlaceholders,
  type ParseError,
  type ParseResult,
  type Placeholder,
  type PlaceholderKind,
  parsePlaceholders,
  stripPlaceholders,
} from "./parser.ts";

// Resolver (DB + RBAC):
export {
  describeConnectorPlaceholders,
  type Environment,
  flattenCredential,
  type ResolveResult,
  type ResolverContext,
  resolvePlaceholders,
  resolveStringPlaceholders,
  type Unresolved,
  type UnresolvedCode,
} from "./resolver.ts";

// Unsupported-placeholder detector (Mustache + bad kinds):
export {
  findUnsupportedPlaceholders,
  type UnsupportedPlaceholder,
  type UnsupportedPlaceholderCode,
} from "./unsupported.ts";
