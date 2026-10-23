import { Bot, Plug, Workflow } from "lucide-react";
import { IconTile, type IconTileSize } from "@/components/cockpit/patterns";
import { type ServiceIdentity, serviceIcon } from "@/lib/service-icons";
import { cn } from "@/lib/utils";

const GLYPH: Record<IconTileSize, string> = {
  sm: "size-4",
  md: "size-[18px]",
  lg: "size-5",
};

function Glyph({ service, size }: { service: ServiceIdentity; size: string }) {
  const icon = serviceIcon(service);
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

export function SubKitMark({ size = "md", tile = true }: { size?: IconTileSize; tile?: boolean }) {
  if (!tile)
    return (
      <span
        aria-hidden="true"
        data-slot="subkit-mark"
        className="inline-grid size-4 shrink-0 place-items-center rounded-[4px] bg-foreground text-background"
      >
        <Workflow className="size-3" strokeWidth={2.4} />
      </span>
    );
  return (
    <IconTile size={size} className="bg-foreground text-background">
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
  if (service.kind === "subkit") return <SubKitMark size={tile} tile={tile !== undefined} />;
  if (!tile) return <Glyph service={service} size={cn("size-4", className)} />;
  return (
    <IconTile size={tile} outline className={className}>
      <Glyph service={service} size={GLYPH[tile]} />
    </IconTile>
  );
}
