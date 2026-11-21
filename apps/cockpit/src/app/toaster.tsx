import { Toaster } from "@ui/organisms/sonner";
import { useTheme } from "@/lib/theme";

export function AppToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} richColors position="bottom-right" />;
}
