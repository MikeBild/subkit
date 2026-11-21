import { cn } from "@ui/lib/utils";
import { Bot, Plug, Workflow } from "lucide-react";
import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";
import { IconTile, type IconTileSize } from "@/components/cockpit/patterns";
import {
  namedService,
  onServiceMarks,
  type ServiceIdentity,
  serviceIcon,
  serviceMarksReady,
  serviceNameOf,
} from "@/lib/service-icons";

const GLYPH: Record<IconTileSize, string> = {
  sm: "size-4",
  md: "size-[18px]",
  lg: "size-5",
};

function Glyph({ service, size }: { service: ServiceIdentity; size: string }) {
  useSyncExternalStore(onServiceMarks, serviceMarksReady, serviceMarksReady);
  const icon = serviceIcon(service);
  if (icon === "loading")
    return (
      <span
        aria-hidden="true"
        data-slot="service-glyph"
        data-loading="true"
        className={cn("inline-block shrink-0", size)}
      />
    );
  if (icon?.mono)
    return (
      <span
        aria-hidden="true"
        data-slot="service-glyph"
        className={cn("inline-block shrink-0 bg-current", size)}
        style={{
          maskImage: `url("${icon.src}")`,
          WebkitMaskImage: `url("${icon.src}")`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    );
  if (icon)
    return (
      <img
        src={icon.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-slot="service-glyph"
        className={cn("inline-block shrink-0 object-contain", size)}
      />
    );
  const Fallback = service.kind === "generic" && service.driver === "mcp" ? Bot : Plug;
  return (
    <Fallback
      aria-hidden="true"
      data-slot="service-glyph"
      className={cn("shrink-0 text-muted-foreground", size)}
    />
  );
}

export function SubKitMark({
  size = "md",
  tile = true,
  className,
}: {
  size?: IconTileSize;
  tile?: boolean;
  className?: string;
}) {
  if (!tile)
    return (
      <span
        aria-hidden="true"
        data-slot="subkit-mark"
        className={cn(
          "inline-grid size-4 shrink-0 place-items-center rounded-[4px] bg-foreground text-background",
          className,
        )}
      >
        <Workflow className="size-3/4" strokeWidth={2.4} />
      </span>
    );
  return (
    <IconTile size={size} className={cn("bg-foreground text-background", className)}>
      <Workflow data-slot="subkit-mark" strokeWidth={2.2} />
    </IconTile>
  );
}

export function ServiceIcon({
  service,
  tile,
  className,
}: {
  service: ServiceIdentity;
  tile?: IconTileSize;
  className?: string;
}) {
  if (service.kind === "subkit")
    return <SubKitMark size={tile} tile={tile !== undefined} className={className} />;
  if (!tile) return <Glyph service={service} size={cn("size-4", className)} />;
  return (
    <IconTile size={tile} outline className={className}>
      <Glyph service={service} size={GLYPH[tile]} />
    </IconTile>
  );
}

export function ServiceChips({
  refs,
  className,
  envs,
}: {
  refs: string[];
  className?: string;
  envs?: Record<string, string> | undefined;
}) {
  const names = [...new Set(refs.map(serviceNameOf))];
  if (!names.length) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
      {names.map((name) => (
        <span
          key={name}
          className="inline-flex h-6 items-center gap-2 rounded-full border bg-background pl-1 pr-2 text-xs"
        >
          <ServiceIcon service={namedService(name)} />
          {name}
          {envs?.[name] && <span className="text-muted-foreground">· {envs[name]}</span>}
        </span>
      ))}
    </span>
  );
}

export type AssistantMarkKind = "claude" | "codex" | "subkit" | "bot";

const ASSISTANT_BRAND: Record<"claude" | "codex", { key: string; color: string }> = {
  claude: { key: "claude", color: "var(--sk-agent-claude)" },
  codex: { key: "openai", color: "var(--sk-agent-codex)" },
};

function AssistantGlyph({ mark, size }: { mark: AssistantMarkKind; size: string }) {
  if (mark === "subkit")
    return (
      <Workflow
        aria-hidden="true"
        data-slot="assistant-glyph"
        strokeWidth={2.2}
        className={cn("shrink-0 text-accent", size)}
      />
    );
  if (mark === "bot")
    return (
      <Bot
        aria-hidden="true"
        data-slot="assistant-glyph"
        className={cn("shrink-0 text-accent", size)}
      />
    );
  const brand = ASSISTANT_BRAND[mark];
  const style: CSSProperties = { color: brand.color };
  return (
    <span className="inline-flex shrink-0" style={style} data-slot="assistant-glyph">
      <Glyph service={{ kind: "brand", key: brand.key }} size={size} />
    </span>
  );
}

export function AssistantIcon({
  mark,
  tile,
  className,
}: {
  mark: AssistantMarkKind;
  tile?: IconTileSize;
  className?: string;
}) {
  if (!tile) return <AssistantGlyph mark={mark} size={cn("size-4", className)} />;
  return (
    <IconTile size={tile} outline className={className}>
      <AssistantGlyph mark={mark} size={GLYPH[tile]} />
    </IconTile>
  );
}
