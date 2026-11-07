// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  secretSetting,
  SettingsSecretValue,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DEFAULT_HUB_BASE_URL } from "./hubConfig.ts";

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      // RahBaz Client: this is the only provider — on by default.
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    hubBaseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_HUB_BASE_URL)),
      Schema.annotateKey({
        title: "RahBaz Hub URL",
        description:
          "URL of a Hub you already run. The Client installer does not install Hub; only connect here.",
        providerSettingsForm: {
          placeholder: DEFAULT_HUB_BASE_URL,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    hubApiKey: SettingsSecretValue.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Hub API key",
        description:
          "Gateway key from Hub config (access.api-keys). After this, models and chats work automatically.",
        providerSettingsForm: {
          control: "password",
          placeholder: "rbgw-…",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    // Advanced: auto-managed via ensureOpenCodeBinary — hidden for normal users.
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "OpenCode binary path",
        description: "Leave default; Client discovers or installs OpenCode under ~/.rahbaz.",
        providerSettingsForm: { hidden: true, clearWhenEmpty: "omit" },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "OpenCode server URL",
        description: "Leave blank to let RahBaz Client spawn OpenCode when needed.",
        providerSettingsForm: { hidden: true, clearWhenEmpty: "omit" },
      }),
    ),
    serverPassword: SettingsSecretValue.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "OpenCode server password",
        description: "Stored separately on the host.",
        providerSettingsForm: { hidden: true, clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["hubBaseUrl", "hubApiKey"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;
