/** OpenCode 1.18 needs legacy `provider` (not `providers`) for Hub-only config. */

export const RAHBAZ_API_KEY_ENV = "RAHBAZ_API_KEY";
export const DEFAULT_HUB_BASE_URL = "http://127.0.0.1:8317";
export const RAHBAZ_PROVIDER_ID = "rahbaz";

export type HubModel = {
  readonly id: string;
  readonly name?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function hubV1BaseUrl(hubBaseUrl: string): string {
  const base = normalizeBaseUrl(hubBaseUrl || DEFAULT_HUB_BASE_URL);
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export async function fetchHubModels(
  hubBaseUrl: string,
  hubApiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubModel[]> {
  const key = (hubApiKey ?? "").trim();
  if (!key) return [];

  const url = `${hubV1BaseUrl(hubBaseUrl)}/models`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`RahBaz Hub catalog failed: HTTP ${response.status} for ${url}`);
  }
  const json = (await response.json()) as {
    data?: Array<{ id?: string; name?: string }>;
    models?: Array<{ id?: string; name?: string }>;
  };
  const rows = json.data ?? json.models ?? [];
  const models: HubModel[] = [];
  for (const row of rows) {
    const id = (row.id ?? row.name ?? "").trim();
    if (!id) continue;
    models.push({ id, name: row.name?.trim() || id });
  }
  return models;
}

/** T3 customModels entries so the Client picker lists Hub models even before OpenCode refresh. */
export function hubModelsToCustomModels(
  models: ReadonlyArray<HubModel>,
): Array<{ slug: string; name: string }> {
  return models.map((model) => ({
    slug: `${RAHBAZ_PROVIDER_ID}/${model.id}`,
    name: model.name ?? model.id,
  }));
}

/**
 * OpenCode 1.x-compatible inline config: allowlist ONLY RahBaz Hub.
 */
export function buildOpenCodeConfigContent(input: {
  readonly hubBaseUrl: string;
  readonly models: ReadonlyArray<HubModel>;
  readonly apiKeyEnv?: string;
}): string {
  const apiKeyEnv = input.apiKeyEnv ?? RAHBAZ_API_KEY_ENV;
  const baseURL = hubV1BaseUrl(input.hubBaseUrl);
  const models: Record<string, { name: string }> = {};
  for (const model of input.models) {
    models[model.id] = { name: model.name ?? model.id };
  }
  if (Object.keys(models).length === 0) {
    models["hub-empty"] = {
      name: "No Hub models yet: set Hub API key + login accounts, then refresh",
    };
  }

  const firstId = Object.keys(models)[0]!;

  return JSON.stringify({
    // Without these, OpenCode keeps showing built-in Zen/opencode models.
    enabled_providers: [RAHBAZ_PROVIDER_ID],
    disabled_providers: [
      "opencode",
      "openai",
      "anthropic",
      "google",
      "gemini",
      "openrouter",
      "xai",
      "amazon-bedrock",
      "azure",
      "groq",
      "mistral",
      "deepseek",
      "together",
      "cohere",
    ],
    model: `${RAHBAZ_PROVIDER_ID}/${firstId}`,
    // Legacy key required by OpenCode 1.18 — do NOT also emit `providers`.
    provider: {
      [RAHBAZ_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "RahBaz",
        options: {
          baseURL,
          apiKey: `{env:${apiKeyEnv}}`,
        },
        models,
      },
    },
  });
}

export function buildRahBazProcessEnvironment(input: {
  readonly baseEnvironment: Readonly<Record<string, string | undefined>>;
  readonly hubBaseUrl: string;
  readonly hubApiKey: string;
  readonly models: ReadonlyArray<HubModel>;
  /** Optional OpenCode isolation dirs (config/data/cache/state) under ~/.rahbaz. */
  readonly openCodeIsolation?: Readonly<Record<string, string>>;
}): Record<string, string | undefined> {
  return {
    ...input.baseEnvironment,
    ...input.openCodeIsolation,
    [RAHBAZ_API_KEY_ENV]: input.hubApiKey,
    OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent({
      hubBaseUrl: input.hubBaseUrl,
      models: input.models,
    }),
  };
}
