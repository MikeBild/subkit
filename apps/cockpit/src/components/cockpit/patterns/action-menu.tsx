import { MoreHorizontal } from "lucide-react";
import { IconButton } from "@/components/cockpit/icon-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n-context";

export interface ActionMenuItem {
  label: string;
  onSelect?(): void;
  href?: string;
  disabled?: boolean;
  /** Why it is disabled — the tooltip, instead of a sentence on the page. */
  disabledReason?: string;
  destructive?: boolean;
  testId?: string;
  /**
   * Further `data-*` attributes for the entry — e.g. `data-opens` naming the
   * dialog it opens, so the single-trigger check counts a menu entry like a
   * button.
   */
  data?: Readonly<Record<`data-${string}`, string>>;
}

/**
 * The only ⋯ (P16). One item is not a menu: it stands as a named outline
 * button, so nobody opens a menu to find a single entry.
 */
export function ActionMenu({
  items,
  size = "default",
  label,
  testId,
}: {
  items: readonly ActionMenuItem[];
  label?: string;
  testId?: string;
  /** `sm` for a row action inside a table or a card. */
  size?: "default" | "sm";
}) {
  const { t } = useI18n();
  const [only] = items;
  if (!only) return null;
  if (items.length === 1) {
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
