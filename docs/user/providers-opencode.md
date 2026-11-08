# OpenCode

Install and authenticate OpenCode on the machine running your environment, then
enable it in **Settings > Providers**. See [provider setup](./install.md#providers).
RahBaz requires OpenCode 1.14.19 or newer, including when you connect an existing
OpenCode server.

## RahBaz Hub pin

RahBaz Client installs and runs **OpenCode 1.18.x** under `~/.rahbaz` so Hub-only
config (legacy `provider` allowlist) works. That pin is **fully supported** for this
product — you should not see a Limited support warning for it.

OpenCode 2 is also detected when present, but Hub connection is validated on the
pinned 1.18.x path. Do not run OpenCode 1.x and 2.x side by side on the same
machine against the same data directory.

Plan mode uses OpenCode's `plan` agent.

## Compaction

OpenCode compacts long conversations itself, and RahBaz has no setting for it. On
OpenCode 2, change it under `compaction` in an OpenCode configuration file, such as
`opencode.json`: `auto` turns
automatic compaction on or off, `buffer` sets the token headroom, and `keep.tokens`
sets how much recent context stays. OpenCode 1.x configures compaction differently.
Send `/compact` to compact a thread yourself.

## Local or external server

Leave **Server URL** empty to let RahBaz start OpenCode locally. A password in
provider settings applies to both that server and RahBaz's connection. With no
password setting, the local server uses `OPENCODE_SERVER_PASSWORD` from its
environment.

To use an existing OpenCode server, set **Server URL** and its password in provider
settings. RahBaz uses only that configured password for an external server; it
does not forward a local `OPENCODE_SERVER_PASSWORD`. If connection or version checks
fail, check the URL, credentials, and OpenCode version, then refresh provider status.

After a lost connection, send another prompt to reconnect to the same OpenCode
session.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn.

## Refresh models, commands, and skills

After changing an OpenCode login or configuration, use **Refresh provider status**
in **Settings > Providers** for that environment. On mobile, use **Refresh models**
in the thread settings. Reconnecting also refreshes the catalog; periodic provider
health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain
cached while the local helper is running. Let it sit for 30 seconds without model
refreshes or text-generation work, then refresh again to reload the files. Repeated
refreshes keep the helper alive. An external server may need its own reload or
restart before RahBaz can see configuration changes.

Existing threads keep their selected model and options even when it disappears
from the catalog. If OpenCode rejects that model, select an available one and retry.
