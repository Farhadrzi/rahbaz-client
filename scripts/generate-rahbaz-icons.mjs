#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- Maintainer Node script; no Effect HostProcess. */
/** Convert assets/icon.svg into packaging PNGs/ICO under assets/rahbaz/. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(__dirname, "..");
const svgCandidates = [
  NodePath.join(repoRoot, "assets/rahbaz/icon.svg"),
  NodePath.join(repoRoot, "assets/icon.svg"),
];
const outDir = NodePath.join(repoRoot, "assets/rahbaz");

const targets = {
  "ios-1024.png": 1024,
  "macos-1024.png": 1024,
  "universal-1024.png": 1024,
  "web-apple-touch-180.png": 180,
  "web-icon-192x192.png": 192,
  "web-icon-512x512.png": 512,
  "web-favicon-16x16.png": 16,
  "web-favicon-32x32.png": 32,
};

function which(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = NodeChildProcess.spawnSync(probe, [cmd], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : null;
}

function printManualSteps(svg) {
  console.error(`
RahBaz icon conversion tools were not found (sharp / ImageMagick / sips).

Install one of:
  npm i -D sharp png-to-ico
  # or ImageMagick: https://imagemagick.org/

Then re-run: node scripts/generate-rahbaz-icons.mjs

Manual ImageMagick fallback from ${svg}:
  magick "${svg}" -resize 1024x1024 "${NodePath.join(outDir, "macos-1024.png")}"
  magick "${svg}" -define icon:auto-resize=256,128,64,48,32,16 "${NodePath.join(outDir, "windows.ico")}"
`);
}

async function withSharp(svg) {
  const require = NodeModule.createRequire(import.meta.url);
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    try {
      sharp = require(NodePath.join(repoRoot, "node_modules/sharp"));
    } catch {
      return false;
    }
  }
  const resolvePngToIco = () => {
    for (const candidate of [
      "png-to-ico",
      NodePath.join(NodeOS.tmpdir(), "rahbaz-icon-tools/node_modules/png-to-ico"),
    ]) {
      try {
        const mod = require(candidate);
        return typeof mod === "function" ? mod : (mod.default ?? null);
      } catch {
        // try next
      }
    }
    return null;
  };
  const pngToIco = resolvePngToIco();

  NodeFS.mkdirSync(outDir, { recursive: true });
  const masterBuffer = await sharp(svg).resize(1024, 1024).png().toBuffer();
  for (const [name, size] of Object.entries(targets)) {
    const dest = NodePath.join(outDir, name);
    await sharp(masterBuffer).resize(size, size).png().toFile(dest);
  }
  if (pngToIco) {
    try {
      const icoSizes = [16, 32, 48, 64, 128, 256];
      const pngBuffers = [];
      for (const size of icoSizes) {
        pngBuffers.push(await sharp(masterBuffer).resize(size, size).png().toBuffer());
      }
      NodeFS.writeFileSync(NodePath.join(outDir, "windows.ico"), await pngToIco(pngBuffers));
      NodeFS.writeFileSync(
        NodePath.join(outDir, "web-favicon.ico"),
        await pngToIco([pngBuffers[0], pngBuffers[1]]),
      );
    } catch (error) {
      console.warn("png-to-ico failed; PNGs were written. Create .ico with ImageMagick:", error);
    }
  } else {
    console.warn(
      "png-to-ico not installed; wrote PNGs only. Install png-to-ico for windows.ico / favicon.ico.",
    );
  }
  console.log(`Wrote RahBaz icons under ${outDir}`);
  return true;
}

function withImageMagick(svg) {
  const magick = which("magick");
  if (!magick) return false;
  NodeFS.mkdirSync(outDir, { recursive: true });
  for (const [name, size] of Object.entries(targets)) {
    const dest = NodePath.join(outDir, name);
    const result = NodeChildProcess.spawnSync(magick, [svg, "-resize", `${size}x${size}`, dest], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      return false;
    }
  }
  const ico = NodePath.join(outDir, "windows.ico");
  const favicon = NodePath.join(outDir, "web-favicon.ico");
  const icoResult = NodeChildProcess.spawnSync(
    magick,
    [svg, "-define", "icon:auto-resize=256,128,64,48,32,16", ico],
    { encoding: "utf8" },
  );
  const favResult = NodeChildProcess.spawnSync(
    magick,
    [
      NodePath.join(outDir, "web-favicon-16x16.png"),
      NodePath.join(outDir, "web-favicon-32x32.png"),
      favicon,
    ],
    { encoding: "utf8" },
  );
  if (icoResult.status !== 0 || favResult.status !== 0) {
    console.warn(
      "PNG generation succeeded; ICO conversion failed. Install a full ImageMagick build.",
    );
  }
  console.log(`Wrote RahBaz icons under ${outDir} via ${magick}`);
  return true;
}

const svg = svgCandidates.find((candidate) => NodeFS.existsSync(candidate));
if (!svg) {
  console.error("Missing RahBaz SVG at assets/icon.svg or assets/rahbaz/icon.svg");
  process.exit(1);
}
NodeFS.mkdirSync(outDir, { recursive: true });
if (!NodeFS.existsSync(NodePath.join(outDir, "icon.svg"))) {
  NodeFS.copyFileSync(svg, NodePath.join(outDir, "icon.svg"));
}

const ok =
  (await withSharp(svg).catch((error) => {
    console.warn("sharp conversion failed:", error);
    return false;
  })) || withImageMagick(svg);

if (!ok) {
  printManualSteps(svg);
  process.exit(2);
}
