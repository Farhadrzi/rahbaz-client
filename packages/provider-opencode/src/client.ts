import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OpenCodeSettings } from "./settings.ts";

// Keep driverKind "opencode" for harness compatibility; UI label is RahBaz.
export const openCodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("opencode"),
  label: "RahBaz",
  acpRegistryAgentIds: ["opencode", "opencode-v2"],
  settingsSchema: OpenCodeSettings,
  icon: {
    viewBox: "0 0 32 40",
    fill: { light: "#0B3D2E", dark: "#7DFFB3" },
    paths: [
      { d: "M24 32H8V16H24V32Z", fill: { light: "#C8F5DC", dark: "#1A5C40" } },
      { d: "M24 8H8V32H24V8ZM32 40H0V0H32V40Z" },
    ],
  },
});
