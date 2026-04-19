// Placeholder substitution — public surface.
//
// Parser (pure, no I/O):
export {
  collectTokenNames,
  hasPlaceholders,
  parsePlaceholders,
  stripPlaceholders,
  type ParseError,
  type ParseResult,
  type Placeholder,
  type PlaceholderKind,
} from "./parser.ts";

// Resolver (DB + RBAC):
export {
  describeConnectorPlaceholders,
  flattenCredential,
  resolvePlaceholders,
  resolveStringPlaceholders,
  type Environment,
  type ResolverContext,
  type ResolveResult,
  type Unresolved,
  type UnresolvedCode,
} from "./resolver.ts";
