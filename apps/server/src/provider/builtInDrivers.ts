import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import type {
  AnyProviderDriver,
  ProviderUsageReaderEnv,
} from "@t3tools/provider-core/server/driver";

/**
 * RahBaz Client: only the Hub-backed OpenCode driver is registered.
 * Stock Claude/Codex/Cursor/Antigravity/etc. are intentionally omitted so
 * the Client cannot bypass RahBaz Hub.
 */
export type BuiltInDriversEnv = OpenCodeDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  OpenCodeDriver,
];

export type BuiltInUsageReadersEnv = ProviderUsageReaderEnv<typeof OpenCodeDriver>;

/** Order matters: aggregation keeps the first duplicate record. */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [OpenCodeDriver];
