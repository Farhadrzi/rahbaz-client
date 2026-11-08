import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("uses a RahBaz-specific Electron userData folder (not RahBaz)", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const production = yield* resolveUserDataPath({
      appDataDirectory: "/Users/alice/AppData/Roaming",
      isDevelopment: false,
      platform: "win32",
    });
    const development = yield* resolveUserDataPath({
      appDataDirectory: "/Users/alice/AppData/Roaming",
      isDevelopment: true,
      platform: "win32",
    });
    assert.equal(production, path.join("/Users/alice/AppData/Roaming", "rahbaz"));
    assert.equal(development, path.join("/Users/alice/AppData/Roaming", "rahbaz-dev"));
    assert.isFalse(production.toLowerCase().includes("t3code"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
