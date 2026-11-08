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
const DOWNLOAD_USER_AGENT = `RahBaz-Client/${PINNED_OPENCODE_VERSION} (OpenCode bootstrap)`;

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

function releaseArch(): "arm64" | "x64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function releaseArchiveName(baseline = false): string {
  const arch = releaseArch();
  const baselineSuffix = baseline ? "-baseline" : "";
  if (process.platform === "win32") {
    return `opencode-windows-${arch}${baselineSuffix}.zip`;
  }
  if (process.platform === "darwin") {
    return `opencode-darwin-${arch}${baselineSuffix}.zip`;
  }
  return `opencode-linux-${arch}${baselineSuffix}.tar.gz`;
}

function githubReleaseDownloadUrl(version: string, baseline = false): string {
  const file = releaseArchiveName(baseline);
  return `https://github.com/${OPENCODE_RELEASE_OWNER}/${OPENCODE_RELEASE_REPO}/releases/download/v${version}/${file}`;
}

/** npm hosts the same platform binaries; more reliable when GitHub release CDN fails. */
export function npmPlatformPackageName(baseline = false): string {
  const arch = releaseArch();
  const baselineSuffix = baseline ? "-baseline" : "";
  if (process.platform === "win32") {
    return `opencode-windows-${arch}${baselineSuffix}`;
  }
  if (process.platform === "darwin") {
    return `opencode-darwin-${arch}${baselineSuffix}`;
  }
  return `opencode-linux-${arch}${baselineSuffix}`;
}

function npmPlatformTarballUrl(version: string, baseline = false): string {
  const name = npmPlatformPackageName(baseline);
  return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
}

async function downloadToFile(
  url: string,
  destinationPath: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      "User-Agent": DOWNLOAD_USER_AGENT,
      Accept: "*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  if (response.body) {
    try {
      await NodeStreamPromises.pipeline(
        NodeStream.Readable.fromWeb(response.body as never),
        NodeFS.createWriteStream(destinationPath),
      );
      return;
    } catch (cause) {
      // Some Electron builds expose a body that cannot be streamed via fromWeb.
      if (!(cause instanceof Error)) throw cause;
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error(`Empty download body for ${url}`);
  }
  await NodeFSP.writeFile(destinationPath, buffer);
}

async function downloadWithRetries(
  url: string,
  destinationPath: string,
  fetchImpl: typeof fetch,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadToFile(url, destinationPath, fetchImpl);
      return;
    } catch (cause) {
      lastError = cause;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Download failed for ${url}: ${String(lastError)}`);
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
        { windowsHide: true, timeout: 180_000 },
      );
      return;
    }
    await execFileAsync("unzip", ["-o", archivePath, "-d", destinationDir], {
      timeout: 180_000,
    });
    return;
  }
  // .tar.gz (GitHub linux or npm platform tarball)
  await execFileAsync("tar", ["-xzf", archivePath, "-C", destinationDir], {
    timeout: 180_000,
    windowsHide: true,
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

async function installFromUrl(input: {
  readonly url: string;
  readonly archiveName: string;
  readonly productHome: string;
  readonly version: string;
  readonly fetchImpl: typeof fetch;
}): Promise<string> {
  const binDir = managedOpenCodeBinDir(input.productHome);
  const target = managedOpenCodeBinaryPath(input.productHome);
  await NodeFSP.mkdir(binDir, { recursive: true });

  const tmpRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rahbaz-opencode-"));
  try {
    const archivePath = NodePath.join(tmpRoot, input.archiveName);
    await downloadWithRetries(input.url, archivePath, input.fetchImpl);
    const extractDir = NodePath.join(tmpRoot, "extract");
    await extractArchive(archivePath, extractDir);
    const found = await findExtractedBinary(extractDir);
    if (!found) {
      throw new Error(`Archive from ${input.url} did not contain an opencode binary.`);
    }
    await NodeFSP.copyFile(found, target);
    if (process.platform !== "win32") {
      await NodeFSP.chmod(target, 0o755);
    }
    await NodeFSP.writeFile(
      NodePath.join(binDir, "VERSION"),
      `${input.version}\n# source ${input.url}\n# sha256 ${NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(archivePath))
        .digest("hex")}\n`,
      "utf8",
    );
    return target;
  } finally {
    await NodeFSP.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installPinnedOpenCode(input?: {
  readonly productHome?: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const productHome = input?.productHome ?? productHomeFromEnv();
  const version = input?.version ?? PINNED_OPENCODE_VERSION;
  const fetchImpl = input?.fetchImpl ?? fetch;
  const errors: string[] = [];

  // Prefer npm registry first: GitHub release assets frequently 504 / block in some networks.
  for (const baseline of [false, true]) {
    // baseline packages exist for x64 only on some platforms; skip impossible names.
    if (baseline && releaseArch() === "arm64") continue;
    const url = npmPlatformTarballUrl(version, baseline);
    try {
      return await installFromUrl({
        url,
        archiveName: `${npmPlatformPackageName(baseline)}-${version}.tgz`,
        productHome,
        version,
        fetchImpl,
      });
    } catch (cause) {
      errors.push(`npm(${baseline ? "baseline" : "default"}): ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  for (const baseline of [false, true]) {
    if (baseline && releaseArch() === "arm64") continue;
    const url = githubReleaseDownloadUrl(version, baseline);
    try {
      return await installFromUrl({
        url,
        archiveName: releaseArchiveName(baseline),
        productHome,
        version,
        fetchImpl,
      });
    } catch (cause) {
      errors.push(
        `github(${baseline ? "baseline" : "default"}): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  throw new Error(
    `Could not install OpenCode ${version} for ${process.platform}/${process.arch}. ${errors.join(" | ")}`,
  );
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
