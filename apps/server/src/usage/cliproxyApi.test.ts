import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    name: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    name: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.optional(Schema.String),
  authIndex: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    accounts?: Array<
      (typeof accounts)[number] & {
        disabled?: boolean;
        id?: string;
        name?: string;
        auth_index?: string | number;
        id_token?: {
          chatgpt_account_id?: string;
          plan_type?: string;
          chatgpt_plan_type?: string;
        };
        chatgpt_account_id?: string;
        metadata?: { chatgpt_account_id?: string; plan_type?: string };
      }
    >;
    /** Prefer Hub dashboard shapes: object body under /v8/management. */
    mode?: "v8" | "v0-legacy";
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
    /** When true, api-call returns body as a JSON object instead of a string. */
    objectApiBody?: boolean;
  } = {},
) {
  const mode = options.mode ?? "v8";
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });

      if (mode === "v8") {
        if (
          path.endsWith("/v0/management/auth-files") ||
          path.endsWith("/v0/management/api-call")
        ) {
          return HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 }));
        }
        if (path.endsWith("/v8/management/credentials") || path.endsWith("/credentials")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ files: options.accounts ?? accounts }),
          );
        }
        if (path.endsWith("/routing/cooldown/reset") || path.endsWith("/reset-quota")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { status: "ok", auth_index: body?.auth_index },
              {
                status: options.cooldownStatus ?? 200,
              },
            ),
          );
        }
        expect(path).toMatch(/\/v8\/management\/requests\/api-call$/);
      } else {
        if (
          path.endsWith("/v8/management/credentials") ||
          path.endsWith("/v8/management/requests/api-call") ||
          path.endsWith("/v8/management/routing/cooldown/reset")
        ) {
          return HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 }));
        }
        if (path.endsWith("/auth-files")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              files: (options.accounts ?? accounts).map((account) => ({
                ...account,
                id: account.id ?? account.name,
              })),
            }),
          );
        }
        if (path.endsWith("/reset-quota")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({}, { status: options.cooldownStatus ?? 200 }),
          );
        }
        expect(path).toMatch(/\/v0\/management\/api-call$/);
      }

      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      expect(body?.auth_index ?? body?.authIndex).toBeTruthy();
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      const useObjectBody = options.objectApiBody ?? mode === "v8";
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: upstream.status,
          body: useObjectBody ? upstream.body : encodeJson(upstream.body),
        }),
      );
    }),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(NodeCrypto.layer),
    ),
  };
}

const unreachableHub = (
  fail: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => HttpClientError.HttpClientError,
) =>
  makeCliproxyApi.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.fail(fail(request))),
    ),
    Effect.provide(NodeCrypto.layer),
  );

describe("CLIProxyAPI hub failures", () => {
  it.effect("names the TLS code when the hub's certificate is not trusted", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              // Node's fetch wraps the TLS error, which carries the code, in a generic TypeError.
              cause: new TypeError("fetch failed", {
                cause: Object.assign(new Error("unable to get local issuer certificate"), {
                  code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                }),
              }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
      expect(error.detail).toContain("NODE_EXTRA_CA_CERTS");
    }),
  );

  // regression: #18168 Limits hub failures name their TLS, HTTP, or timeout cause
  it.effect("ignores a transport code that is not a short Node error code", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("odd"), { code: "X".repeat(200) }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toBe("The hub management request failed.");
    }),
  );

  it.effect("names the status, not the body, when the hub rejects the request", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "management-secret is wrong" }, { status: 401 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, test),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("401");
      expect(error.detail).not.toContain("management-secret");
    }),
  );
});

describe("CLIProxyAPI v8 management API", () => {
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture();
        const api = yield* test.api;
        const result = yield* api.readAccounts(config);
        expect(result.map((account) => account.id)).toEqual(["first.json", "second.json"]);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(calls.every((request) => request.body?.authIndex === request.body?.auth_index)).toBe(
          true,
        );
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
        expect(
          test.requests.every(
            (request) =>
              request.path.includes("/v8/management/credentials") ||
              request.path.includes("/v8/management/requests/api-call"),
          ),
        ).toBe(true);
      }),
  );

  it.effect("accepts numeric auth_index and account ids from the name field", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            name: "claude-a.json",
            auth_index: 42,
            provider: "claude",
            email: "claude@example.com",
          },
        ],
        upstream: () => ({
          status: 200,
          body: { five_hour: { utilization: 11, resets_at: null } },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("claude-a.json");
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(11);
      expect(test.requests.some((request) => request.body?.auth_index === "42")).toBe(true);
    }),
  );

  it.effect("resolves ChatGPT account ids from metadata when id_token is absent", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            name: "meta.json",
            auth_index: "m",
            provider: "codex",
            metadata: { chatgpt_account_id: "account-meta", plan_type: "plus" },
          },
        ],
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 200, body: { credits: [] } }
            : {
                status: 200,
                body: { rate_limit: { primary_window: { used_percent: 9 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.workspaceId).toBe("account-meta");
      expect(result[0]?.plan).toBe("ChatGPT Plus Subscription");
      expect(
        test.requests.find((request) => request.body?.url?.endsWith("/usage"))?.body?.header?.[
          "Chatgpt-Account-Id"
        ],
      ).toBe("account-meta");
    }),
  );

  it.effect("marks unsupported hub providers as unavailable instead of crashing", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            name: "ag.json",
            auth_index: "z",
            provider: "antigravity",
          },
          {
            name: "ok.json",
            auth_index: "a",
            provider: "codex",
            id_token: { chatgpt_account_id: "account-a" },
          },
        ],
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 200, body: { credits: [] } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 3 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      // antigravity is filtered from the usage source list; only codex/claude are shown.
      expect(result.map((account) => account.id)).toEqual(["ok.json"]);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(3);
    }),
  );

  it.effect("resolves a missing usage plan from current, then legacy, token plans", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            name: "first.json",
            auth_index: "a",
            provider: "codex",
            id_token: { chatgpt_account_id: "account-a", plan_type: "free" },
          },
          {
            name: "second.json",
            auth_index: "b",
            provider: "codex",
            id_token: {
              chatgpt_account_id: "account-b",
              plan_type: "go",
              chatgpt_plan_type: "plus",
            },
          },
          {
            name: "third.json",
            auth_index: "c",
            provider: "codex",
            id_token: { chatgpt_account_id: "account-c", chatgpt_plan_type: "free" },
          },
        ],
        upstream: (request) => ({
          status: 200,
          body: {
            ...(request.auth_index === "a" ? { plan_type: "plus" } : {}),
            rate_limit: { primary_window: { used_percent: 12 } },
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result.map((account) => [account.plan, account.usageLimits.windows[0]?.kind])).toEqual(
        [
          ["ChatGPT Plus Subscription", "session"],
          ["ChatGPT Go Subscription", "monthly"],
          ["ChatGPT Free Subscription", "monthly"],
        ],
      );
    }),
  );

  it.effect.each([
    "https://tools.test/cliproxy",
    "https://tools.test/cliproxy/",
    "https://tools.test/cliproxy/management.html",
    "https://tools.test/cliproxy/management.html/",
    "https://tools.test/cliproxy/MANAGEMENT.HTML",
    "https://tools.test/cliproxy/management.html?tab=accounts",
    "https://tools.test/cliproxy/management.html#accounts",
    "https://tools.test/cliproxy/management.html/?tab=accounts",
    "https://tools.test/cliproxy/management.html/#accounts",
  ])("keeps the path of a hub served under a prefix: %s", (url) =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) => request.path.startsWith("/cliproxy/v8/management/")),
      ).toBe(true);
    }),
  );

  it.effect("preserves a hub path that only ends with the panel filename", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url: "https://tools.test/team-management.html" });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) =>
          request.path.startsWith("/team-management.html/v8/management/"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("maps Claude scoped windows without a scheduler plugin", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        // The usage endpoint answers 429 to requests without a Claude client user agent.
        upstream: (request) => ({
          status:
            request.header?.["User-Agent"]?.includes("claude-cli/") ||
            request.header?.["User-Agent"]?.startsWith("claude-code/")
              ? 200
              : 429,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  it.effect.each([
    {
      name: "spend budget",
      budget: {
        spend: {
          enabled: true,
          used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
          limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        },
      },
    },
    {
      name: "extra usage",
      budget: {
        extra_usage: {
          is_enabled: true,
          used_credits: 4_631,
          monthly_limit: 50_000,
          utilization: 9,
        },
      },
    },
  ])("keeps Claude monthly spend from $name beside rolling windows", ({ budget }) =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: { five_hour: { utilization: 10, resets_at: null }, ...budget },
        }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["monthly_spend", expect.closeTo(9.262, 10)],
      ]);
    }),
  );

  it.effect("omits disabled Claude budgets without losing rolling windows", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            spend: { enabled: false, used: null, limit: null },
            extra_usage: {
              is_enabled: false,
              used_credits: null,
              monthly_limit: null,
              utilization: null,
            },
          },
        }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(result[0]?.usageLimits.windows.map((window) => window.id)).toEqual(["five_hour"]);
    }),
  );

  it.effect("pins redemption to the displayed credit and clears only that account's cooldown", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: "519d5243-011a-5b7b-91f3-44d85f095705",
          credit_id: "credit-b",
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/routing/cooldown/reset"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["b", "b"]);
    }),
  );

  it.effect("reports redemption success even if cooldown clearing fails", () =>
    Effect.gen(function* () {
      const api = yield* fixture({ cooldownStatus: 404 }).api;
      const result = yield* api.consume(config, "first.json", "credit");
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("cooldown");
    }),
  );

  it.effect("skips disabled accounts and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      expect(yield* api.readAccounts(config)).toEqual([]);
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(
        test.requests.every((request) => request.path.endsWith("/v8/management/credentials")),
      ).toBe(true);
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(
        test.requests.filter((request) => request.path.endsWith("/routing/cooldown/reset")),
      ).toHaveLength(1);
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );
});

describe("CLIProxyAPI v0 management fallback", () => {
  it.effect("falls back to auth-files and api-call when v8 routes are missing", () =>
    Effect.gen(function* () {
      const test = fixture({ mode: "v0-legacy", objectApiBody: false });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(78);
      expect(
        test.requests.some((request) => request.path.endsWith("/v8/management/credentials")),
      ).toBe(true);
      expect(
        test.requests.some((request) => request.path.endsWith("/v0/management/auth-files")),
      ).toBe(true);
      expect(
        test.requests.some((request) => request.path.endsWith("/v0/management/api-call")),
      ).toBe(true);
    }),
  );

  it.effect("clears cooldown via legacy reset-quota after a v8 404", () =>
    Effect.gen(function* () {
      const test = fixture({ mode: "v0-legacy", objectApiBody: false });
      const api = yield* test.api;
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({ outcome: "reset" });
      expect(
        test.requests.some((request) => request.path.endsWith("/v0/management/reset-quota")),
      ).toBe(true);
    }),
  );
});
