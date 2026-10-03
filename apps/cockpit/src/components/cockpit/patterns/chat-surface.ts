// The transcript primitives only Chat composes (spec §6: Chat may use the
// conversation elements besides the patterns): messages, bubbles, the
// scroller that follows a streaming answer, and the popover and command list
// of the @-mention picker. Re-exported here so this directory stays the only
// one that imports `@/components/ui/*`; no other page has a use for them.

export { Bubble, BubbleContent } from "@/components/ui/bubble";
export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
export {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
export { ScrollArea } from "@/components/ui/scroll-area";
