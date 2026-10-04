export const RUN_VERB_RE =
  /^(run|execute|starte|f[uü]hre)\s+(?:die\s+|the\s+)?(?:workflow\s+)?([a-z0-9_][a-z0-9_-]*)(?:\s+aus)?\s*$/i;

export const INSPECT_EXEC_RE =
  /^(inspect|show|zeige)\s+(?:the\s+|die\s+)?execution\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;

export const AFFIRM_RE =
  /^(yes|yep|yeah|y|ok|okay|ack|approve|approved|do it|go|run it|sí|si|ja|jo|los|bestätigt|confirm)\.?!?$/i;
