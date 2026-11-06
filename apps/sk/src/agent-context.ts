import { randomUUID } from "node:crypto";
import { getBriefingHookOutput } from "./commands/agent.ts";
import type { ResolvedProfile } from "./config.ts";
import type { FetchLike } from "./engine-client.ts";

export interface AgentBriefingUpdate {
  status: string | null;
  changed: boolean;
}

interface AgentBriefingContextOptions {
  profile: ResolvedProfile;
  cwd: string;
  sessionId?: string;
  sessionDirectory?: string;
  fetchImpl?: FetchLike;
}

export class AgentBriefingContext {
  private readonly profile: ResolvedProfile;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly sessionDirectory: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private loadedContext: string | null = null;

  constructor(options: AgentBriefingContextOptions) {
    this.profile = options.profile;
    this.cwd = options.cwd;
    this.sessionId = options.sessionId ?? randomUUID();
    this.sessionDirectory = options.sessionDirectory;
    this.fetchImpl = options.fetchImpl;
  }

  async start(): Promise<AgentBriefingUpdate> {
    const output = await getBriefingHookOutput(
      {
        hook_event_name: "SessionStart",
        cwd: this.cwd,
        session_id: this.sessionId,
        transcript_path: null,
        prompt: null,
      },
      {
        profile: this.profile,
        ...(this.sessionDirectory ? { sessionDirectory: this.sessionDirectory } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      },
    );
    const context = output?.hookSpecificOutput?.additionalContext ?? null;
    this.loadedContext = context;
    return { status: output?.systemMessage ?? null, changed: context !== null };
  }

  async beforePrompt(prompt: string): Promise<AgentBriefingUpdate> {
    const output = await getBriefingHookOutput(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: this.cwd,
        session_id: this.sessionId,
        transcript_path: null,
        prompt,
      },
      {
        profile: this.profile,
        ...(this.sessionDirectory ? { sessionDirectory: this.sessionDirectory } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      },
    );
    const context = output?.hookSpecificOutput?.additionalContext ?? null;
    const changed = output?.systemMessage === "✓ SubKit" && context !== null;
    if (changed) {
      this.loadedContext = [this.loadedContext, context].filter(Boolean).join("\n\n---\n\n");
    }
    return {
      status: changed || output?.systemMessage === "⚠ SubKit" ? output.systemMessage : null,
      changed,
    };
  }

  memory(localMemory: string | null, additionalContext?: string | null): string | null {
    const parts = [localMemory, this.loadedContext, additionalContext].filter(
      (part): part is string => Boolean(part),
    );
    return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
  }
}
