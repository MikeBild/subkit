// The form controls a page puts inside the patterns: the filled page action a
// `PageHeader` holds, the fields of a `FormDialog`, a settings form's inputs.
// They are the shadcn primitives themselves — re-exported here so that this
// directory stays the only one that imports `@/components/ui/*`. Containers
// (card, alert, dialog, sheet, tabs, empty, skeleton, badge, dropdown) are not
// here on purpose: each has its pattern.

export { Button, buttonVariants } from "@/components/ui/button";
export { Checkbox } from "@/components/ui/checkbox";
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
export { Input } from "@/components/ui/input";
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
export { Label } from "@/components/ui/label";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export { Spinner } from "@/components/ui/spinner";
export { Switch } from "@/components/ui/switch";
export { Textarea } from "@/components/ui/textarea";
