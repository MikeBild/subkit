import { Button } from "@ui/atoms/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ui/molecules/dropdown-menu";
import { IconButton } from "@ui/molecules/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/molecules/tooltip";
import { MoreHorizontal } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";

export interface ActionMenuItem {
  label: string;
  onSelect?(): void;
  href?: string;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
}

export function ActionMenu({
  items,
  alwaysMenu = false,
  size = "default",
  label,
  testId,
}: {
  items: readonly ActionMenuItem[];
  alwaysMenu?: boolean;
  label?: string;
  testId?: string;
  size?: "default" | "sm";
}) {
  const { t } = useI18n();
  const [only] = items;
  if (!only) return null;
  if (items.length === 1 && !alwaysMenu) {
    const button = only.href ? (
      <Button variant="outline" size={size} asChild data-testid={only.testId ?? testId}>
        <a href={only.href} data-testid={only.testId ?? testId} {...only.data}>
          {only.label}
        </a>
      </Button>
    ) : (
      <Button
        variant="outline"
        size={size}
        disabled={only.disabled}
        onClick={only.onSelect}
        data-testid={only.testId ?? testId}
        {...only.data}
      >
        {only.label}
      </Button>
    );
    if (!only.disabled || !only.disabledReason) return button;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{only.disabledReason}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          variant="outline"
          size={size === "sm" ? "icon-sm" : "icon"}
          label={label ?? t("pattern.moreActions")}
          data-testid={testId ?? "action-menu"}
        >
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            disabled={item.disabled}
            variant={item.destructive ? "destructive" : "default"}
            title={item.disabled ? item.disabledReason : undefined}
            data-testid={item.testId}
            {...item.data}
            asChild={Boolean(item.href)}
            onSelect={item.onSelect}
          >
            {item.href ? (
              <a href={item.href} data-testid={item.testId}>
                {item.label}
              </a>
            ) : (
              item.label
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
