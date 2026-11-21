import { DropdownMenuContent as UiDropdownMenuContent } from "@ui/components/ui/dropdown-menu";
import type * as React from "react";

function DropdownMenuContent({
  align = "start",
  ...props
}: React.ComponentProps<typeof UiDropdownMenuContent>) {
  return <UiDropdownMenuContent align={align} {...props} />;
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";
export { DropdownMenuContent };
