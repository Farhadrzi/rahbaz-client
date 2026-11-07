/* oxlint-disable t3code/no-global-process-runtime -- Node installer helper runs before Effect HostProcess is wired. */
/** Discover PATH OpenCode or install a pinned release under ~/.rahbaz/tools. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";
import { defaultProductHome, resolveConfiguredProductHome } from "@t3tools/shared/productIdentity";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/** Pinned official OpenCode CLI release used when none is on PATH. */
export const PINNED_OPENCODE_VERSION = "1.18.5";
const OPENCODE_RELEASE_OWNER = "anomalyco";
const OPENCODE_RELEASE_REPO = "opencode";

export type EnsureOpenCodeResult = {
  readonly binaryPath: string;
  readonly source: "path" | "configured" | "managed";
  readonly version: string | null;
};

function productHomeFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfiguredProductHome(env) ?? defaultProductHome(NodeOS.homedir(), NodePath.join);
}

export function managedOpenCodeBinDir(productHome = productHomeFromEnv()): string {
  return NodePath.join(productHome, "tools", "opencode", "bin");
}

export function managedOpenCodeBinaryPath(productHome = productHomeFromEnv()): string {
  const name = process.platform === "win32" ? "opencode.exe" : "opencode";
  return NodePath.join(managedOpenCodeBinDir(productHome), name);
}

export function openCodeIsolationEnvironment(
  productHome = productHomeFromEnv(),
): Record<string, string> {
  const root = NodePath.join(productHome, "opencode");
  return {
    OPENCODE_CONFIG_DIR: NodePath.join(root, "config"),
    OPENCODE_DATA_DIR: NodePath.join(root, "data"),
    OPENCODE_CACHE_DIR: NodePath.join(root, "cache"),
    OPENCODE_STATE_DIR: NodePath.join(root, "state"),
    OPENCODE_APPNAME: "rahbaz-opencode",
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

async function probeVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      windowsHide: true,
      timeout: 15_000,
      env: process.env,
    });
    const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout);
    return match?.[1] ?? (stdout.trim() || null);
  } catch {
    return null;
  }
}

async function resolveOnPath(command = "opencode"): Promise<string | null> {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(which, [command], {
      windowsHide: true,
      timeout: 10_000,
      env: process.env,
    });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

function releaseArchiveName(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (process.platform === "win32") {
    return `opencode-windows-${arch}.zip`;
  }
  if (process.platform === "darwin") {
    return `opencode-darwin-${arch}.zip`;
  }
  return `opencode-linux-${arch}.tar.gz`;
}

function releaseDownloadUrl(version = PINNED_OPENCODE_VERSION): string {
  const file = releaseArchiveName();
  return `https://github.com/${OPENCODE_RELEASE_OWNER}/${OPENCODE_RELEASE_REPO}/releases/download/v${version}/${file}`;
}

async function extractArchive(archivePath: string, destinationDir: string): Promise<void> {
  await NodeFSP.mkdir(destinationDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
        ],
        { windowsHide: true, timeout: 120_000 },
      );
      return;
    }
    await execFileAsync("unzip", ["-o", archivePath, "-d", destinationDir], {
      timeout: 120_000,
    });
    return;
  }
  await execFileAsync("tar", ["-xzf", archivePath, "-C", destinationDir], {
    timeout: 120_000,
  });
}

async function findExtractedBinary(root: string): Promise<string | null> {
  const wanted = process.platform === "win32" ? "opencode.exe" : "opencode";
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = await NodeFSP.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name === wanted || entry.name === "opencode") {
        return full;
      }
    }
  }
  return null;
}

async function installPinnedOpenCode(input?: {
  readonly productHome?: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const productHome = input?.productHome ?? productHomeFromEnv();
  const version = input?.version ?? PINNED_OPENCODE_VERSION;
  const fetchImpl = input?.fetchImpl ?? fetch;
  const binDir = managedOpenCodeBinDir(productHome);
  const target = managedOpenCodeBinaryPath(productHome);
  await NodeFSP.mkdir(binDir, { recursive: true });

  const url = releaseDownloadUrl(version);
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download OpenCode ${version}: HTTP ${response.status} for ${url}`);
  }

  const tmpRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rahbaz-opencode-"));
  try {
    const archivePath = NodePath.join(tmpRoot, releaseArchiveName());
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body as never),
      NodeFS.createWriteStream(archivePath),
    );
    const extractDir = NodePath.join(tmpRoot, "extract");
    await extractArchive(archivePath, extractDir);
    const found = await findExtractedBinary(extractDir);
    if (!found) {
      throw new Error(`OpenCode archive from ${url} did not contain an opencode binary.`);
    }
    await NodeFSP.copyFile(found, target);
    if (process.platform !== "win32") {
      await NodeFSP.chmod(target, 0o755);
    }
    await NodeFSP.writeFile(
      NodePath.join(binDir, "VERSION"),
      `${version}\n# source ${url}\n# sha256 ${NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(archivePath))
        .digest("hex")}\n`,
      "utf8",
    );
    return target;
  } finally {
    await NodeFSP.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Prefer an explicit path, then PATH, then a previously managed install, else download the pin.
 */
export async function ensureOpenCodeBinary(input?: {
  readonly configuredPath?: string;
  readonly productHome?: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<EnsureOpenCodeResult> {
  const configured = input?.configuredPath?.trim();
  if (configured && configured !== "opencode" && (await pathExists(configured))) {
    return {
      binaryPath: configured,
      source: "configured",
      version: await probeVersion(configured),
    };
  }

  const onPath = await resolveOnPath("opencode");
  if (onPath) {
    return {
      binaryPath: onPath,
      source: "path",
      version: await probeVersion(onPath),
    };
  }

  const productHome = input?.productHome ?? productHomeFromEnv();
  const managed = managedOpenCodeBinaryPath(productHome);
  if (await pathExists(managed)) {
    return {
      binaryPath: managed,
      source: "managed",
      version: await probeVersion(managed),
    };
  }

  const installed = await installPinnedOpenCode({
    productHome,
    version: input?.version,
    fetchImpl: input?.fetchImpl,
  });
  return {
    binaryPath: installed,
    source: "managed",
    version: await probeVersion(installed),
  };
}
