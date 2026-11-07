import { describe, expect, it } from "vitest";
import {
  buildOpenCodeConfigContent,
  buildRahBazProcessEnvironment,
  fetchHubModels,
  hubV1BaseUrl,
  RAHBAZ_API_KEY_ENV,
} from "./hubConfig.ts";

describe("hubConfig", () => {
  it("normalizes /v1 base URL", () => {
    expect(hubV1BaseUrl("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317/v1");
    expect(hubV1BaseUrl("http://127.0.0.1:8317/")).toBe("http://127.0.0.1:8317/v1");
    expect(hubV1BaseUrl("http://127.0.0.1:8317/v1")).toBe("http://127.0.0.1:8317/v1");
  });

  it("builds OpenCode config with Hub-only allowlist and models", () => {
    const raw = buildOpenCodeConfigContent({
      hubBaseUrl: "http://127.0.0.1:8317",
      models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }, { id: "gpt-5" }],
    });
    const json = JSON.parse(raw) as {
      enabled_providers: string[];
      disabled_providers: string[];
      provider: {
        rahbaz: {
          name: string;
          options: { baseURL: string; apiKey: string };
          models: Record<string, { name: string }>;
        };
      };
      providers: {
        rahbaz: {
          name: string;
          settings: { baseURL: string };
          models: Record<string, { name: string }>;
        };
      };
    };
    expect(json.enabled_providers).toEqual(["rahbaz"]);
    expect(json.disabled_providers).toContain("opencode");
    expect(json.provider.rahbaz.name).toBe("RahBaz");
    expect(json.provider.rahbaz.options.baseURL).toBe("http://127.0.0.1:8317/v1");
    expect(json.provider.rahbaz.options.apiKey).toBe(`{env:${RAHBAZ_API_KEY_ENV}}`);
    expect(json.provider.rahbaz.models["claude-sonnet-5"].name).toBe("Claude Sonnet 5");
    expect(json.provider.rahbaz.models["gpt-5"].name).toBe("gpt-5");
    expect((json as { providers?: unknown }).providers).toBeUndefined();
  });

  it("injects OPENCODE_CONFIG_CONTENT and API key into process env", () => {
    const env = buildRahBazProcessEnvironment({
      baseEnvironment: { FOO: "bar" },
      hubBaseUrl: "http://127.0.0.1:8317",
      hubApiKey: "rbgw-test",
      models: [{ id: "m1" }],
    });
    expect(env.FOO).toBe("bar");
    expect(env[RAHBAZ_API_KEY_ENV]).toBe("rbgw-test");
    expect(env.OPENCODE_CONFIG_CONTENT).toContain('"rahbaz"');
    expect(env.OPENCODE_CONFIG_CONTENT).not.toBe("{}");
  });

  it("fetches Hub model catalog", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b", name: "Bee" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const models = await fetchHubModels("http://127.0.0.1:8317", "key", fetchImpl);
    expect(models).toEqual([
      { id: "a", name: "a" },
      { id: "b", name: "Bee" },
    ]);
  });
});
