# RahBaz Client

MIT fork of [T3 Code](https://github.com/pingdotgg/t3code) configured as a **local OpenRouter client**.

- Single provider in the UI: **RahBaz**
- Model picker comes from Hub `GET /v1/models`
- Chat goes to Hub `http://127.0.0.1:8317` (OpenAI-compatible)
- Under the hood: OpenCode runtime with `OPENCODE_CONFIG_CONTENT` locked to the Hub (never `{}`)

Stock Claude / Codex / Cursor / Antigravity providers are **not registered**.

## Prerequisites

1. RahBaz Hub running (`..\..\scripts\up.ps1` from repo root)
2. At least one Hub account logged in (`..\..\scripts\login-*.ps1`)
3. OpenCode CLI on PATH preferred; otherwise RahBaz installs a pinned release into `~/.rahbaz/tools/opencode`
4. Vite+ tooling (`vp`) — see upstream README

User data defaults to `~/.rahbaz` (override with `RAHBAZ_HOME` or `T3CODE_HOME`). This does **not** share `~/.t3` with T3 Code.

## Configure

1. Copy Hub gateway key from `../../config/config.yaml` → `access.api-keys[0]`
2. In RahBaz Client → Settings → Providers → **RahBaz**:
   - Hub URL: `http://127.0.0.1:8317`
   - Hub API key: paste gateway key (Sensitive)
3. Refresh provider / restart Client after adding Hub accounts so the catalog updates

## Build & run (Windows)

Tooling already used on this machine (re-run if a new shell is missing commands):

- Node.js **26.12.1** (`winget install OpenJS.NodeJS -e --version 26.12.1`)
- OpenCode CLI (`winget install SST.opencode`)
- Vite+ / `vp` (`irm https://vite.plus/ps1 | iex`) then activate:
  ```powershell
  . "$env:APPDATA\vite-plus\env.ps1"
  ```
- Monorepo deps: from this directory, `vp i` (pnpm 12.14 via Vite+)

```powershell
cd C:\Users\farha\.t3\projects\rahbaz\clients\rahbaz-client
. "$env:APPDATA\vite-plus\env.ps1"
vp i
vp run dev          # or: vp run start / vp run dev:desktop — see package.json scripts
```

Verify Hub catalog first:

```powershell
..\..\scripts\list-models.ps1
```

## Standalone desktop

From the **parent** RahBaz repo (not this folder):

```powershell
.\scripts\build-desktop-win.ps1
```

See [../../docs/DESKTOP.md](../../docs/DESKTOP.md) for Linux/macOS.

## Attribution

This tree includes upstream T3 Code (Copyright 2026 T3 Tools Inc., MIT). RahBaz patches add Hub-only provider wiring and branding.
