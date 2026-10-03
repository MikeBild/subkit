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
}

/**
 * The only ⋯ (P16). One item is not a menu: it stands as a named outline
 * button, so nobody opens a menu to find a single entry.
 */
export function ActionMenu({
  items,
  label,
  testId,
}: {
  items: readonly ActionMenuItem[];
  label?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const [only] = items;
  if (!only) return null;
  if (items.length === 1) {
    const button = only.href ? (
      <Button variant="outline" asChild data-testid={only.testId ?? testId}>
        <a href={only.href} data-testid={only.testId ?? testId}>
          {only.label}
        </a>
      </Button>
    ) : (
      <Button
        variant="outline"
        disabled={only.disabled}
        onClick={only.onSelect}
        data-testid={only.testId ?? testId}
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
          size="icon"
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
