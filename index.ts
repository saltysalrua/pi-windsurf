/**
 * Windsurf Provider for Pi
 *
 * Enables Windsurf/Cognition models via cloud-direct API.
 * Models are fetched dynamically from GetCliModelConfigs (Devin CLI endpoint).
 *
 * Usage: /login windsurf → /model windsurf/<id>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { startProxy, stopProxy, PROXY_SECRET, setProxyCredentials } from "./proxy";
import { loadCredentials, saveCredentials, deleteCredentials, DEFAULT_REGION, runLoginLoopback, registerUser, type PersistedCredentials } from "./oauth";
import { clearCachedUserJwt } from "./auth";
import { clearSessionIds } from "./chat";
import { clearCachedCatalog, getCachedCatalog, type ModelCatalogEntry, type ModelFeatures } from "./catalog";
import { getUserStatus, clearAssignmentCache, type UserStatus } from "./assign";

let _pi: ExtensionAPI | null = null;

/** Build a Pi model definition from a catalog entry. */
function catalogModelToPi(m: ModelCatalogEntry) {
  const ctx = m.contextWindow ?? 0;
  const maxOut = m.maxOutputTokens ?? 0;
  const isFree = !m.hasPricing;
  const tags: string[] = [];
  if (isFree) tags.push("Free");
  if (m.promoActive) tags.push(m.promoLabel || "Promo");
  if (m.isNew) tags.push("New");
  if (m.isModelRouter) tags.push("Router");
  const tagStr = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  const ctxStr = ctx > 0 ? ` (${ctx >= 1_000_000 ? `${Math.round(ctx / 1_000_000)}M` : `${Math.round(ctx / 1_000)}K`})` : "";
  const f = m.features;
  return {
    id: m.modelUid,
    name: `${m.label}${tagStr}${ctxStr}`,
    reasoning: f?.supportsThinking ?? true,
    input: ["text", ...(f?.supportsImageCaptions !== false ? ["image"] : [])] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctx || 1,
    maxTokens: maxOut || 1,
  };
}

/** Fetch catalog and build dynamic model list. */
async function fetchDynamicModels(apiKey: string, apiServerUrl: string): Promise<ReturnType<typeof catalogModelToPi>[]> {
  try {
    const catalog = await getCachedCatalog(apiKey, apiServerUrl);
    if (catalog && catalog.byUid.size > 0) {
      const models = [...catalog.byUid.values()]
        .filter((m) => !m.disabled)
        .map(catalogModelToPi);
      return models;
    }
  } catch {}
  return [];
}

// OAuth
async function loginWindsurf(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  let token: string;
  try {
    token = await runLoginLoopback(DEFAULT_REGION, (url) => callbacks.onAuth({ url }));
  } catch {
    const pasted = await callbacks.onPrompt({
      message: `Open this URL, sign in, paste callback URL or token:\n\n  ${DEFAULT_REGION.website}/windsurf/signin\n\nPaste:`,
    });
    const trimmed = pasted.trim();
    try {
      const u = new URL(trimmed);
      token = u.searchParams.get("firebase_id_token") ?? u.searchParams.get("access_token") ?? u.searchParams.get("token") ?? trimmed;
    } catch { token = trimmed; }
  }
  if (!token) throw new Error("No token received.");

  const result = await registerUser(token, DEFAULT_REGION);
  saveCredentials({ ...result, issuedAt: new Date().toISOString(), oauthClientId: DEFAULT_REGION.oauthClientId });
  setProxyCredentials({ apiKey: result.apiKey, apiServerUrl: result.apiServerUrl });
  clearCachedUserJwt();
  clearSessionIds();
  clearCachedCatalog();
  return { refresh: result.apiKey, access: result.apiKey, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
}

async function refreshWindsurfToken(c: OAuthCredentials): Promise<OAuthCredentials> { return c; }

// Extension entry
export default async function (pi: ExtensionAPI) {
  _pi = pi;

  const proxyPort = await startProxy();
  const baseUrl = `http://127.0.0.1:${proxyPort}/v1`;

  let hasCreds = false;
  let apiKey = "";
  let apiServerUrl = "https://server.self-serve.windsurf.com";
  try {
    const stored = loadCredentials();
    if (stored) {
      setProxyCredentials({ apiKey: stored.apiKey, apiServerUrl: stored.apiServerUrl });
      hasCreds = true;
      apiKey = stored.apiKey;
      apiServerUrl = stored.apiServerUrl;
    }
  } catch {}

  // Fetch models dynamically from catalog
  const models = hasCreds
    ? await fetchDynamicModels(apiKey, apiServerUrl)
    : [];

  pi.registerProvider("windsurf", {
    name: "Cognition (Windsurf)",
    baseUrl, apiKey: PROXY_SECRET, api: "openai-completions", authHeader: true,
    models,
    oauth: {
      name: "Windsurf (Cognition)",
      login: loginWindsurf,
      refreshToken: refreshWindsurfToken,
      getApiKey: (creds: OAuthCredentials) => creds.access,
    },
  });



  pi.registerCommand("windsurf-status", {
    description: "Show Windsurf auth status, plan, and quota",
    handler: async (_args, ctx) => {
      const c = loadCredentials();
      if (!c) {
        ctx.ui.notify("Windsurf: not signed in. /login windsurf", "warning");
        return;
      }
      try {
        const status = await getUserStatus(c.apiKey, c.apiServerUrl);
        const parts: string[] = [];
        parts.push(status.planName ? `Plan: ${status.planName}` : "Plan: unknown");
        if (status.isPro) parts.push("Pro");
        if (status.isTeams) parts.push("Teams");
        if (status.isEnterprise) parts.push("Enterprise");
        if (status.availablePromptCredits !== undefined) parts.push(`Credits: ${status.availablePromptCredits}/${status.monthlyPromptCredits ?? "?"} prompts`);
        if (status.availableFlowCredits !== undefined) parts.push(`Flow: ${status.availableFlowCredits}/${status.monthlyFlowCredits ?? "?"}`);
        if (status.dailyQuotaRemainingPercent !== undefined) parts.push(`Daily: ${status.dailyQuotaRemainingPercent}%`);
        if (status.weeklyQuotaRemainingPercent !== undefined) parts.push(`Weekly: ${status.weeklyQuotaRemainingPercent}%`);
        if (status.canUseCascade === false) parts.push("Cascade: disabled");
        if (status.canUseCli === false) parts.push("CLI: disabled");
        ctx.ui.notify(`Windsurf: ${parts.join(" | ")}`, "info");
      } catch (e) {
        ctx.ui.notify(`Windsurf: authenticated (${c.apiServerUrl}) but status fetch failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
      }
    },
  });

  pi.registerCommand("windsurf-logout", {
    description: "Sign out of Windsurf",
    handler: async (_args, ctx) => {
      const ok = deleteCredentials();
      setProxyCredentials(null);
      clearCachedUserJwt(); clearSessionIds(); clearCachedCatalog(); clearAssignmentCache();
      ctx.ui.notify(ok ? "Windsurf: signed out." : "Already signed out.", "info");
    },
  });

  pi.registerCommand("windsurf-refresh", {
    description: "Refresh Windsurf model catalog",
    handler: async (_args, ctx) => {
      const c = loadCredentials();
      if (!c) {
        ctx.ui.notify("Windsurf: not signed in. /login windsurf", "warning");
        return;
      }
      clearCachedCatalog();
      try {
        const catalog = await getCachedCatalog(c.apiKey, c.apiServerUrl);
        if (catalog) {
          ctx.ui.notify(`Windsurf: refreshed ${catalog.byUid.size} models. Restart Pi to apply.`, "info");
        } else {
          ctx.ui.notify("Windsurf: refresh failed. Check connection.", "warning");
        }
      } catch (e) {
        ctx.ui.notify(`Windsurf: refresh error - ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // Show resolved model info in the status bar
  pi.on("model_select", async (event, ctx) => {
    const m = event.model;
    if (m?.id && m.provider === "windsurf") {
      ctx.ui.setStatus("windsurf", m.id);
    }
  });

  // Show thinking level in status bar when it changes
  pi.on("thinking_level_select", async (event, ctx) => {
    if (ctx.model?.provider === "windsurf") {
      const level = event.level;
      ctx.ui.setStatus("windsurf", `${ctx.model?.id ?? "?"} · ${level}`);
    }
  });

  // Show thinking status during requests, clear on completion
  pi.on("before_provider_request", async (_event, ctx) => {
    if (ctx.model?.provider === "windsurf") {
      ctx.ui.setWorkingMessage(`windsurf ${ctx.model.id} ...`);
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (ctx.model?.provider === "windsurf") {
      ctx.ui.setWorkingMessage();
      if (event.status < 200 || event.status >= 300) {
        ctx.ui.notify(`Windsurf error: HTTP ${event.status}`, "error");
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("windsurf", undefined);
    _pi = null;
    stopProxy();
  });
}
