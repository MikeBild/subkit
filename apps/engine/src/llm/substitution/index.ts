// Placeholder substitution — public surface.
//
// Parser (pure, no I/O):
export {
  collectTokenNames,
  hasPlaceholders,
  type ParseError,
  parsePlaceholders,
  type ParseResult,
  type Placeholder,
  type PlaceholderKind,
  stripPlaceholders,
} from "./parser.ts";

// Resolver (DB + RBAC):
export {
  describeConnectorPlaceholders,
  type Environment,
  flattenCredential,
  resolvePlaceholders,
  type ResolverContext,
  type ResolveResult,
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
