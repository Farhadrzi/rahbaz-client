import { describe, expect, it } from "vitest";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  managedOpenCodeBinDir,
  managedOpenCodeBinaryPath,
  openCodeIsolationEnvironment,
  PINNED_OPENCODE_VERSION,
} from "./ensureBinary.ts";

describe("ensureOpenCodeBinary helpers", () => {
  it("pins an official OpenCode release for managed installs", () => {
    expect(PINNED_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
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
});
