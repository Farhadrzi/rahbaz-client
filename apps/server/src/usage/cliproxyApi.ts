import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { codexPlanLabel } from "../provider/CodexProvider.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/claudeUsageLimits.ts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

/** A hub with its management key already read from wherever the setting keeps it. */
export interface CliproxyHub {
  readonly url: UsageLimitSourceConfig["url"];
  readonly managementKey: string;
}

/** Normalized credential row used for usage probes and reset-credit redemption. */
interface HubAccount {
  readonly id: string;
  readonly auth_index: string;
  readonly provider: string;
  readonly email?: string;
  readonly disabled?: boolean;
  readonly chatgpt_account_id?: string;
  readonly plan_type?: string;
  readonly chatgpt_plan_type?: string;
}

const ApiResponse = Schema.Struct({
  status_code: Schema.Number,
  // CLIProxyAPI v8 may return a JSON object; older builds stringified the upstream body.
  body: Schema.Unknown,
});
const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  limit_window_seconds: Schema.optional(Schema.Number),
});
const CodexUsage = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
    }),
  ),
});
const ClaudeWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  spend: Schema.optional(Schema.Unknown),
  extra_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        is_enabled: Schema.Boolean,
        monthly_limit: Schema.NullOr(Schema.Number),
        used_credits: Schema.NullOr(Schema.Number),
        utilization: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
const CreditList = Schema.Struct({
  credits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      reset_type: Schema.String,
      expires_at: Schema.String,
    }),
  ),
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeCreditList = Schema.decodeUnknownEffect(CreditList);
const decodeClaudeUsage = Schema.decodeUnknownEffect(ClaudeUsage);
const decodeCodexUsage = Schema.decodeUnknownEffect(CodexUsage);
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

const trimString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nestedString = (
  root: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined => {
  for (const key of keys) {
    const direct = trimString(root[key]);
    if (direct) return direct;
  }
  for (const nestKey of ["metadata", "attributes", "id_token"] as const) {
    const nested = asRecord(root[nestKey]);
    if (!nested) continue;
    for (const key of keys) {
      const value = trimString(nested[key]);
      if (value) return value;
    }
  }
  return undefined;
};

/** Map either /v8/management/credentials or legacy /auth-files rows into one shape. */
const normalizeHubAccount = (raw: unknown): HubAccount | undefined => {
  const row = asRecord(raw);
  if (!row) return undefined;
  const id = trimString(row.name) ?? trimString(row.id);
  const auth_index = trimString(row.auth_index) ?? trimString(row.authIndex);
  const provider = (trimString(row.provider) ?? trimString(row.type) ?? "").toLowerCase();
  if (!id || !auth_index || !provider) return undefined;
  const email = trimString(row.email);
  const chatgpt_account_id = nestedString(row, ["chatgpt_account_id", "chatgptAccountId"]);
  const plan_type = nestedString(row, ["plan_type", "planType"]);
  const chatgpt_plan_type = nestedString(row, ["chatgpt_plan_type", "chatgptPlanType"]);
  return {
    id,
    auth_index,
    provider,
    ...(email ? { email } : {}),
    ...(typeof row.disabled === "boolean" ? { disabled: row.disabled } : {}),
    ...(chatgpt_account_id ? { chatgpt_account_id } : {}),
    ...(plan_type ? { plan_type } : {}),
    ...(chatgpt_plan_type ? { chatgpt_plan_type } : {}),
  };
};

const decodeHubAccounts = (response: unknown): ReadonlyArray<HubAccount> => {
  const root = asRecord(response);
  const files = Array.isArray(root?.files) ? root.files : Array.isArray(response) ? response : [];
  return files.flatMap((file) => {
    const account = normalizeHubAccount(file);
    return account ? [account] : [];
  });
};

const decodeJsonBody = <A, R>(
  body: unknown,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError, R>,
): Effect.Effect<A, Schema.SchemaError, R> => {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return decode({});
    try {
      return decode(JSON.parse(trimmed) as unknown);
    } catch {
      return decode(body);
    }
  }
  return decode(body);
};

// Extra CAs can fix untrusted chains; expiry/hostname failures report codes only.
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// fetch wraps Node error codes in generic TypeErrors.
const nodeErrorCode = (cause: unknown) => {
  for (let error = cause, depth = 0; error instanceof Error && depth < 3; depth += 1) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = error.cause;
  }
  return undefined;
};

const httpStatus = (error: unknown): number | undefined => {
  if (!HttpClientError.isHttpClientError(error)) return undefined;
  const reason = error.reason;
  return reason._tag === "StatusCodeError" ? reason.response.status : undefined;
};

// Hub responses can contain credentials; expose only failure kind, HTTP status or Node code.
const describeManagementFailure = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "The hub did not answer within 15 seconds.";
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    if (reason._tag === "StatusCodeError") {
      return `The hub answered with HTTP ${reason.response.status}.`;
    }
    const code = reason._tag === "TransportError" ? nodeErrorCode(reason.cause) : undefined;
    if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
      return `The hub's TLS certificate is not trusted (${code}). If it comes from a private CA, add that CA to NODE_EXTRA_CA_CERTS.`;
    }
    if (code !== undefined) return `The hub request failed (${code}).`;
  }
  return "The hub management request failed.";
};
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
  }),
);

const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;

/** Prefer CLIProxyAPI v8 paths; keep v0 aliases for older hubs. */
const CREDENTIAL_LIST_PATHS = ["v8/management/credentials", "v0/management/auth-files"] as const;
const API_CALL_PATHS = ["v8/management/requests/api-call", "v0/management/api-call"] as const;
const RESET_COOLDOWN_PATHS = [
  "v8/management/routing/cooldown/reset",
  "v0/management/reset-quota",
] as const;

const CREDIT_REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
const creditRedeemRequestId = Effect.fn("CliproxyApi.creditRedeemRequestId")(function* (
  accountId: string,
  creditId: string,
) {
  const digest = yield* Digest.Digest;
  const name = new TextEncoder().encode(`${accountId}:${creditId}`);
  const input = new Uint8Array(CREDIT_REDEEM_NAMESPACE.length + name.length);
  input.set(CREDIT_REDEEM_NAMESPACE);
  input.set(name, CREDIT_REDEEM_NAMESPACE.length);
  const bytes = (yield* digest.digest(Digest.sha1, input).pipe(Effect.orDie)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

const managementUrl = (hubUrl: string, path: string) => {
  const base = new URL(hubUrl);
  // Users often paste the hub's web panel URL, which ends in management.html.
  base.pathname = base.pathname.replace(/(\/management\.html)?\/?$/i, "/");
  return new URL(path, base).toString();
};

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;

  const managementOnce = Effect.fn("CliproxyApi.managementOnce")(function* (
    hub: CliproxyHub,
    path: string,
    body?: unknown,
  ) {
    const url = yield* Effect.try({
      try: () => managementUrl(hub.url, path),
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = (
      body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${hub.managementKey}`));
    // Keep raw HTTP failures so callers can treat 404 as "try the next path alias".
    return yield* client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
      );
  });

  /** Try current Hub paths first; fall through only on HTTP 404 (missing route). */
  const management = Effect.fn("CliproxyApi.management")(function* (
    hub: CliproxyHub,
    paths: ReadonlyArray<string>,
    body?: unknown,
  ) {
    let lastError: unknown;
    for (const path of paths) {
      const result = yield* managementOnce(hub, path, body).pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      lastError = result.failure;
      if (isUsageLimitSourceError(result.failure)) return yield* result.failure;
      // Only 404 means "try the next alias"; auth/validation errors must surface.
      if (httpStatus(result.failure) !== 404) {
        return yield* new UsageLimitSourceError({
          detail: describeManagementFailure(result.failure),
        });
      }
    }
    return yield* new UsageLimitSourceError({
      detail: describeManagementFailure(lastError),
    });
  });

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (hub: CliproxyHub) {
    const response = yield* management(hub, CREDENTIAL_LIST_PATHS);
    return decodeHubAccounts(response);
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    hub: CliproxyHub,
    account: HubAccount,
    url: string,
    data?: unknown,
  ) {
    const header =
      account.provider === "codex"
        ? {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "OpenAI-Beta": "codex-1",
            Originator: "Codex Desktop",
            ...(account.chatgpt_account_id
              ? { "Chatgpt-Account-Id": account.chatgpt_account_id }
              : {}),
          }
        : {
            Authorization: "Bearer $TOKEN$",
            "anthropic-beta": "oauth-2025-04-20",
            // Match Hub dashboard User-Agent; Anthropic usage can 429 without a Claude client UA.
            "User-Agent": "claude-cli/2.1.280 (external, cli)",
            "Content-Type": "application/json",
            Accept: "application/json",
          };
    // Send both casings: Hub dashboard posts authIndex; older builds expect auth_index.
    const raw = yield* management(hub, API_CALL_PATHS, {
      auth_index: account.auth_index,
      authIndex: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new UsageLimitSourceError({
        detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
      });
    }
    return response.body;
  });

  const credits = Effect.fn("CliproxyApi.credits")(function* (
    hub: CliproxyHub,
    account: HubAccount,
  ) {
    const body = yield* apiCall(hub, account, CREDIT_URL);
    const response = yield* decodeJsonBody(body, decodeCreditList);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return response.credits
      .filter(
        (credit) =>
          credit.reset_type === "codex_rate_limits" &&
          credit.status === "available" &&
          Date.parse(credit.expires_at) > now,
      )
      .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    hub: CliproxyHub,
    account: HubAccount,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: account.id,
      driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),
      ...(account.email ? { email: account.email } : {}),
      ...(account.chatgpt_account_id ? { workspaceId: account.chatgpt_account_id } : {}),
    };
    const read = Effect.gen(function* () {
      if (account.provider === "claude") {
        const body = yield* apiCall(hub, account, "https://api.anthropic.com/api/oauth/usage");
        const usage = yield* decodeJsonBody(body, decodeClaudeUsage);
        const model_scoped = (usage.limits ?? []).flatMap((limit) =>
          limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
            ? [
                {
                  display_name: limit.scope.model.display_name,
                  utilization: limit.percent,
                  resets_at: limit.resets_at ?? null,
                },
              ]
            : [],
        );
        const rateLimits = {
          five_hour: usage.five_hour ?? null,
          seven_day: usage.seven_day ?? null,
          model_scoped,
          spend: usage.spend,
          extra_usage: usage.extra_usage ?? null,
        };
        return {
          ...base,
          plan: "Claude Subscription",
          usageLimits: claudeUsageResponseToLimits({
            checkedAt,
            response: {
              rate_limits_available: true,
              rate_limits: rateLimits,
            },
          }).limits,
        };
      }
      if (account.provider !== "codex") {
        return {
          ...base,
          usageLimits: makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message: `Hub usage for provider "${account.provider}" is not available in RahBaz Client yet.`,
          }),
        };
      }
      const body = yield* apiCall(hub, account, `${CODEX_BASE}/usage`);
      const usage = yield* decodeJsonBody(body, decodeCodexUsage);
      const toWindow = (window: typeof CodexWindow.Type | null | undefined) =>
        window
          ? {
              usedPercent: window.used_percent,
              resetsAt: window.reset_at ?? null,
              ...(window.limit_window_seconds === undefined
                ? {}
                : { windowDurationMins: window.limit_window_seconds / 60 }),
            }
          : null;
      const available = yield* credits(hub, account).pipe(Effect.orElseSucceed(() => undefined));
      const next = available?.[0];
      const planType = usage.plan_type ?? account.plan_type ?? account.chatgpt_plan_type;
      return {
        ...base,
        plan: codexPlanLabel(planType),
        usageLimits: {
          ...codexRateLimitsToLimits({
            checkedAt,
            snapshot: {
              planType: planType ?? null,
              primary: toWindow(usage.rate_limit?.primary_window),
              secondary: toWindow(usage.rate_limit?.secondary_window),
            },
          }),
          ...(available
            ? {
                resetCredits: {
                  availableCount: available.length,
                  ...(next
                    ? {
                        nextCreditId: next.id,
                        nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(next.expires_at)),
                      }
                    : {}),
                },
              }
            : {}),
        },
      };
    });
    return yield* read.pipe(
      Effect.orElseSucceed(() => ({
        ...base,
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "The hub could not read this account's usage.",
        }),
      })),
    );
  });

  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    hub: CliproxyHub,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(hub).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    return yield* Effect.forEach(
      accounts.filter(
        (account) =>
          !account.disabled && (account.provider === "codex" || account.provider === "claude"),
      ),
      (account) => readAccount(hub, account),
      { concurrency: 4 },
    );
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    hub: CliproxyHub,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(hub)).find((account) => account.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        return yield* new UsageLimitSourceError({
          detail: "The Codex hub account is missing or disabled.",
        });
      }
      const body = yield* apiCall(hub, account, `${CREDIT_URL}/consume`, {
        redeem_request_id: yield* creditRedeemRequestId(
          account.chatgpt_account_id ?? account.id,
          creditId,
        ).pipe(Effect.provideService(Digest.Digest, digest)),
        credit_id: creditId,
      });
      const response = yield* decodeJsonBody(body, decodeConsumeResponse);
      const outcome = (
        {
          reset: "reset",
          nothing_to_reset: "nothingToReset",
          no_credit: "noCredit",
          already_redeemed: "alreadyRedeemed",
        } as const
      )[response.code];
      if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
      const cleared = yield* management(hub, RESET_COOLDOWN_PATHS, {
        auth_index: account.auth_index,
      }).pipe(Effect.result);
      return {
        outcome,
        ...(cleared._tag === "Failure"
          ? {
              warning:
                "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
            }
          : {}),
      } as const;
    });
    return yield* operation.pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({
              detail: "The hub returned an unexpected reset-credit response.",
            }),
      ),
    );
  });
  return { readAccounts, consume };
});
