import { compatibilityWarning } from "@cli-core/release/compatibility.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

interface VersionMismatchBannerProps {
  cliVersion: string;
  engineVersion: string;
}

const VersionMismatchBannerImpl: React.FC<VersionMismatchBannerProps> = ({
  cliVersion,
  engineVersion,
}) => {
  const warning = compatibilityWarning(cliVersion, engineVersion);
  if (!warning) return null;
  return (
    <Box>
      <Text color="yellow" bold>
        {`⚠ ${warning}`}
      </Text>
    </Box>
  );
};

export const VersionMismatchBanner = memo(VersionMismatchBannerImpl);
VersionMismatchBanner.displayName = "VersionMismatchBanner";
