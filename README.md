# RahBaz Client

Desktop app that talks **only** to a [RahBaz Hub](https://github.com/Farhadrzi/rahbaz) you run yourself.

MIT fork of [T3 Code](https://github.com/pingdotgg/t3code), branded and isolated so it can sit side-by-side with stock T3 Code.

|                |                                        |
| -------------- | -------------------------------------- |
| Product        | RahBaz Client                          |
| Hub (separate) | https://github.com/Farhadrzi/rahbaz    |
| App id         | `com.rahbaz.client`                    |
| Data home      | `~/.rahbaz`                            |
| Protocol       | `rahbaz://`                            |
| Updates        | GitHub Releases on **this** repository |

## Boundary

- **This installer does not install Hub / Docker.** Hub setup is your responsibility.
- The Client installs connection requirements (OpenCode under `~/.rahbaz` when needed).
- After Hub is running, enter **Hub URL** + **gateway API key** → models and chats work automatically.

See Hub docs: https://github.com/Farhadrzi/rahbaz/blob/main/docs/PRODUCT_BOUNDARY.md

## Install (end users)

1. Set up Hub: https://github.com/Farhadrzi/rahbaz
2. Download a release from https://github.com/Farhadrzi/rahbaz-client/releases
   - Windows x64 NSIS
   - Linux x64 AppImage
   - macOS arm64 (Apple Silicon) and macOS x64 (Intel)
3. Open RahBaz → Settings → Providers → **RahBaz**
   - Hub URL: `http://127.0.0.1:8317`
   - Hub API key: Hub `access.api-keys[0]`

## Automatic releases (CI)

Push a version tag to publish all platforms:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Or run **Actions → Desktop release** manually.

Artifacts upload to a GitHub Release on this repo. Builds are unsigned unless you add signing secrets (SmartScreen / Gatekeeper warnings expected).

## Develop

```bash
# Node 26.12.1 + pnpm via Vite+
vp i
vp run dev:desktop
```

Upstream T3 workflows are archived under `.github/workflows-t3-upstream/` (disabled). Active CI lives in `.github/workflows/`.

## License

MIT (inherits T3 Code). Retain upstream attribution.
