import { describe, expect, it } from "vitest";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ensureOpenCodeBinary,
  managedOpenCodeBinDir,
  managedOpenCodeBinaryPath,
  npmPlatformPackageName,
  openCodeIsolationEnvironment,
  PINNED_OPENCODE_VERSION,
} from "./ensureBinary.ts";

describe("ensureOpenCodeBinary helpers", () => {
  it("pins an official OpenCode release for managed installs", () => {
    expect(PINNED_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("names the npm platform package for the current OS/arch", () => {
    expect(npmPlatformPackageName()).toMatch(/^opencode-(windows|darwin|linux)-(x64|arm64)$/);
  });

  it("places managed binaries under the RahBaz product home", () => {
    const home = NodePath.join(NodeOS.tmpdir(), "rahbaz-home-test");
    expect(managedOpenCodeBinDir(home)).toBe(NodePath.join(home, "tools", "opencode", "bin"));
    expect(managedOpenCodeBinaryPath(home)).toContain(NodePath.join("tools", "opencode", "bin"));
  });

  it("isolates OpenCode config/data under the RahBaz product home", () => {
    const home = NodePath.join(NodeOS.tmpdir(), "rahbaz-home-test");
    const env = openCodeIsolationEnvironment(home);
    expect(env.OPENCODE_CONFIG_DIR).toBe(NodePath.join(home, "opencode", "config"));
    expect(env.OPENCODE_DATA_DIR).toBe(NodePath.join(home, "opencode", "data"));
    expect(env.OPENCODE_APPNAME).toBe("rahbaz-opencode");
  });

  it(
    "can install the pinned OpenCode binary from npm when missing",
    { timeout: 180_000 },
    async () => {
      const productHome = NodePath.join(
        NodeOS.tmpdir(),
        `rahbaz-ensure-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      const result = await ensureOpenCodeBinary({ productHome });
      expect(result.source).toBe("managed");
      expect(result.binaryPath).toBe(managedOpenCodeBinaryPath(productHome));
      expect(result.version ?? "").toContain("1.18");
    },
  );
});
