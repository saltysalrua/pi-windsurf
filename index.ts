/**
 * Windsurf Provider for Pi
 *
 * Enables Windsurf/Cognition models via cloud-direct API.
 * Models are fetched dynamically from GetCliModelConfigs (Devin CLI endpoint).
 *
 * Usage: /login windsurf → /model windsurf/<id>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { startProxy, stopProxy, PROXY_SECRET, setProxyCredentials, getResponseMeta, serializeResponseMeta, getChildProxyUrl } from "./proxy";
import { loadCredentials, saveCredentials, deleteCredentials, DEFAULT_REGION, runLoginLoopback, registerUser, type PersistedCredentials } from "./oauth";
import { clearCachedUserJwt } from "./auth";
import { clearSessionIds } from "./chat";
import { clearCachedCatalog, getCachedCatalog, type ModelCatalogEntry, type ModelFeatures } from "./catalog";
import { getUserStatus, clearAssignmentCache } from "./assign";
import { windsurfEventBus } from "./event-log";

let _pi: ExtensionAPI | null = null;
let _apiKey = "";
let _apiServerUrl = "https://server.self-serve.windsurf.com";





/** Build thinkingLevelMap from catalog label by finding which level word it contains. */
function buildThinkingLevelMap(label: string, familySize: number): ThinkingLevelMap | undefined {
  if (familySize <= 1) return undefined;
  const l = label.toLowerCase();
  // Pi's native level identifiers — from @earendil-works/pi-ai
  const levels: [ThinkingLevel, string[]][] = [
    ["high", ["high"]],
    ["low", ["low"]],
    ["medium", ["medium"]],
    ["minimal", ["minimal"]],
    ["xhigh", ["xhigh", "x-high"]],
  ];
  let matched: ThinkingLevel | null = null;
  for (const [piLevel, words] of levels) {
    if (words.some((w) => l.includes(w))) { matched = piLevel; break; }
  }
  if (!matched) return undefined;
  const map: ThinkingLevelMap = { off: null };
  map[matched] = matched;
  for (const [piLevel] of levels) {
    if (piLevel !== matched) map[piLevel] = null;
  }
  return map;
}

/** Build a Pi model definition from a catalog entry. */
function catalogModelToPi(m: ModelCatalogEntry, familySize: number) {
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
    thinkingLevelMap: buildThinkingLevelMap(m.label, familySize),
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
      const entries = [...catalog.byUid.values()].filter((m) => !m.disabled);
      // Group by modelFamilyUid (proto field 26)
      const families = new Map<string, number>();
      for (const entry of entries) {
        const fam = entry.modelFamilyUid || entry.modelUid;
        families.set(fam, (families.get(fam) || 0) + 1);
      }
      return entries.map((m) => {
        const fam = m.modelFamilyUid || m.modelUid;
        return catalogModelToPi(m, families.get(fam) || 1);
      });
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

  // Child pi-crew workers reuse the parent's proxy instead of starting their own.
  // The parent proxy accepts the persisted apiKey as a valid Bearer token.
  const childProxy = getChildProxyUrl();
  let baseUrl: string;
  let anthropicBaseUrl: string;
  let providerApiKey: string;

  if (childProxy) {
    baseUrl = childProxy.baseUrl;
    anthropicBaseUrl = childProxy.anthropicBaseUrl;
    providerApiKey = childProxy.apiKey;
  } else {
    const proxyPort = await startProxy();
    baseUrl = `http://127.0.0.1:${proxyPort}/v1`;
    anthropicBaseUrl = `http://127.0.0.1:${proxyPort}`; // Anthropic SDK appends /v1/messages
    providerApiKey = PROXY_SECRET;
  }

  let hasCreds = false;
  try {
    const stored = loadCredentials();
    if (stored) {
      setProxyCredentials({ apiKey: stored.apiKey, apiServerUrl: stored.apiServerUrl });
      hasCreds = true;
      _apiKey = stored.apiKey;
      _apiServerUrl = stored.apiServerUrl;
    }
  } catch {}

  // Fetch models dynamically from catalog
  const models = hasCreds
    ? await fetchDynamicModels(_apiKey, _apiServerUrl)
    : [];

  // Register OpenAI-compatible provider (Pi sends OpenAI format -> /v1/chat/completions)
  pi.registerProvider("windsurf", {
    name: "Cognition (Windsurf)",
    baseUrl, apiKey: providerApiKey, api: "openai-completions", authHeader: true,
    models,
    compat: {
      supportsDeveloperRole: true,        // OpenAI format supports developer role; proxy maps to user (source=1)
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      supportsUsageInStreaming: true,
    },
    oauth: {
      name: "Windsurf (Cognition)",
      login: loginWindsurf,
      refreshToken: refreshWindsurfToken,
      getApiKey: (creds: OAuthCredentials) => creds.access,
      modifyModels: (models) => models,
    },
  });

  // Register Anthropic Messages provider (Pi sends Anthropic format -> /v1/messages)
  pi.registerProvider("windsurf-anthropic", {
    name: "Cognition (Windsurf Anthropic)",
    baseUrl: anthropicBaseUrl, apiKey: providerApiKey, api: "anthropic-messages", authHeader: true,
    models,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      supportsUsageInStreaming: true,
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
      pi.unregisterProvider("windsurf");
      pi.unregisterProvider("windsurf-anthropic");
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

  // -- registerTool: windsurf_status — LLM-callable tool to query plan/quota --
  pi.registerTool({
    name: "windsurf_status",
    label: "Windsurf Status",
    description: "Query current Windsurf account status: plan, credits, daily/weekly quota, and feature availability.",
    promptSnippet: "Query Windsurf account status (plan, credits, quota)",
    promptGuidelines: ["Use windsurf_status when the user asks about their Windsurf plan, credits, quota, or account status."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const c = loadCredentials();
      if (!c) {
        return { content: [{ type: "text", text: "Not signed in to Windsurf. Run /login windsurf first." }], details: {} };
      }
      try {
        const status = await getUserStatus(c.apiKey, c.apiServerUrl);
        const lines: string[] = [];
        lines.push(`Plan: ${status.planName ?? "unknown"}${status.isPro ? " (Pro)" : ""}${status.isTeams ? " (Teams)" : ""}${status.isEnterprise ? " (Enterprise)" : ""}`);
        if (status.availablePromptCredits !== undefined && status.monthlyPromptCredits !== undefined) {
          lines.push(`Prompt credits: ${status.availablePromptCredits} / ${status.monthlyPromptCredits}`);
        }
        if (status.availableFlowCredits !== undefined && status.monthlyFlowCredits !== undefined) {
          lines.push(`Flow credits: ${status.availableFlowCredits} / ${status.monthlyFlowCredits}`);
        }
        if (status.dailyQuotaRemainingPercent !== undefined) {
          lines.push(`Daily quota: ${status.dailyQuotaRemainingPercent}% remaining`);
        }
        if (status.weeklyQuotaRemainingPercent !== undefined) {
          lines.push(`Weekly quota: ${status.weeklyQuotaRemainingPercent}% remaining`);
        }
        if (status.canUseCascade === false) lines.push("Cascade: disabled");
        if (status.canUseCli === false) lines.push("CLI: disabled");
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to fetch Windsurf status: ${e instanceof Error ? e.message : String(e)}` }], details: {} };
      }
    },
  });

  // -- appendEntry: persist Windsurf status in session (no LLM context pollution) --
  let _lastStatusEntry: Record<string, unknown> | null = null;

  async function refreshAndPersistStatus(): Promise<void> {
    const c = loadCredentials();
    if (!c) return;
    try {
      const status = await getUserStatus(c.apiKey, c.apiServerUrl);
      _lastStatusEntry = {
        planName: status.planName,
        availablePromptCredits: status.availablePromptCredits,
        monthlyPromptCredits: status.monthlyPromptCredits,
        dailyQuotaRemainingPercent: status.dailyQuotaRemainingPercent,
        availableFlowCredits: status.availableFlowCredits,
        monthlyFlowCredits: status.monthlyFlowCredits,
        weeklyQuotaRemainingPercent: status.weeklyQuotaRemainingPercent,
      };
      pi.appendEntry("windsurf-status", _lastStatusEntry);
      windsurfEventBus.emit("windsurf:status", _lastStatusEntry);
      pi.events.emit("windsurf:status", _lastStatusEntry);
    } catch {}
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "resume" || event.reason === "reload" || event.reason === "new" || event.reason === "fork") {
      const c = loadCredentials();
      if (c) {
        setProxyCredentials({ apiKey: c.apiKey, apiServerUrl: c.apiServerUrl });
        _apiKey = c.apiKey;
        _apiServerUrl = c.apiServerUrl;
        // Restore persisted status from session entries
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "custom" && entry.customType === "windsurf-status") {
            _lastStatusEntry = entry.data as Record<string, unknown>;
          }
        }
        // Fetch fresh status in background
        refreshAndPersistStatus();
      }
    }
  });

  // -- messageRenderer: Windsurf context messages in chat transcript --
  pi.registerMessageRenderer("windsurf-context", (message, { expanded }, theme) => {
    const content = message.content || "";
    const details = (message as any).details as Record<string, unknown> | undefined;
    const isRateLimit = content.includes("429") || content.includes("rate limit");
    const isServerError = content.includes("500") || content.includes("server error");
    const lines: string[] = [];
    if (isRateLimit) {
      const retryAfter = details?.retryAfter ? String(details.retryAfter) : null;
      lines.push(theme.fg("warning", "[rate limit]") + " " + theme.fg("dim", content));
      if (expanded && retryAfter) {
        lines.push(theme.fg("dim", `  Retry after: ${retryAfter}s`));
        lines.push(theme.fg("dim", `  Suggestion: switch model or wait`));
      }
    } else if (isServerError) {
      lines.push(theme.fg("error", "[server error]") + " " + theme.fg("dim", content));
    } else {
      lines.push(theme.fg("muted", "[windsurf]") + " " + theme.fg("dim", content));
    }
    return { render: () => lines, invalidate: () => {} };
  });

  // -- show resolved model info in the status bar + emit event --
  pi.on("model_select", async (event, ctx) => {
    const m = event.model;
    if (m?.id && m.provider === "windsurf") {
      ctx.ui.setStatus("windsurf", m.id);
      windsurfEventBus.emit("windsurf:model_select", { modelId: m.id });
      pi.events.emit("windsurf:model_select", { modelId: m.id });
    }
  });

  // -- show thinking level in status bar + emit event --
  pi.on("thinking_level_select", async (event, ctx) => {
    if (ctx.model?.provider === "windsurf") {
      const level = event.level;
      ctx.ui.setStatus("windsurf", `${ctx.model?.id ?? "?"} · ${level}`);
      windsurfEventBus.emit("windsurf:thinking_level", { level, modelId: ctx.model?.id });
      pi.events.emit("windsurf:thinking_level", { level, modelId: ctx.model?.id });
    }
  });

  // Show thinking status during requests, clear on completion
  pi.on("before_provider_request", async (_event, ctx) => {
    if (ctx.model?.provider === "windsurf") {
      const usage = ctx.getContextUsage();
      const tokens = usage ? `${Math.round(usage.tokens / 1000)}K` : "";
      ctx.ui.setWorkingMessage(`windsurf ${ctx.model.id}${tokens ? ` (${tokens})` : ""} ...`);
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (ctx.model?.provider !== "windsurf") return;
    ctx.ui.setWorkingMessage();
    if (event.status === 429) {
      const retryAfter = event.headers?.["retry-after"];
      ctx.ui.notify(`Windsurf rate limited. Retry after ${retryAfter ?? "?"}s`, "warning");
      windsurfEventBus.emit("windsurf:error", { type: "rate_limit", status: 429, retryAfter });
      pi.events.emit("windsurf:error", { type: "rate_limit", status: 429, retryAfter });
      pi.sendMessage({
        customType: "windsurf-context",
        content: `Windsurf API returned 429 rate limit. ${retryAfter ? `Retry after ${retryAfter}s.` : "Wait before retrying."} Reduce request frequency or switch to a different model.`,
        display: false,
        details: { type: "rate_limit", status: 429, retryAfter: retryAfter ?? null, model: ctx.model?.id ?? null },
      }, { deliverAs: "followUp" });
    } else if (event.status >= 500) {
      ctx.ui.notify(`Windsurf server error: ${event.status}`, "error");
      windsurfEventBus.emit("windsurf:error", { type: "server_error", status: event.status });
      pi.events.emit("windsurf:error", { type: "server_error", status: event.status });
    } else if (event.status >= 400) {
      windsurfEventBus.emit("windsurf:error", { type: "client_error", status: event.status });
      pi.events.emit("windsurf:error", { type: "client_error", status: event.status });
    }
  });

  // Attach Windsurf response metadata to assistant messages.
  // Pi's AssistantMessage doesn't preserve custom fields from the provider response,
  // so the proxy stores metadata in a side channel keyed by responseId.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || ctx.model?.provider !== "windsurf") return;
    const responseId = (event.message as any).responseId as string | undefined;
    if (!responseId) return;
    const meta = getResponseMeta(responseId);
    if (!meta) return;
    return {
      message: {
        ...event.message,
        metadata: { ...(event.message as any).metadata, windsurf: serializeResponseMeta(meta) },
      },
    };
  });

  // -- context: filter/modify messages before each LLM call --
  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== "windsurf") return;
    const messages = event.messages;
    // Remove old windsurf-context messages from earlier turns (keep only the last one)
    let lastContextIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as any;
      if (m.role === "user" && m.customType === "windsurf-context") {
        if (lastContextIdx === -1) {
          lastContextIdx = i;
        } else {
          // Mark earlier ones for removal by splicing
          messages.splice(i, 1);
        }
      }
    }
    // If we removed any, the indices shifted — but we only removed before lastContextIdx so it's stable
    return { messages };
  });

  // -- session_before_compact: add Windsurf status to compaction context --
  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== "windsurf") return;
    // Don't cancel compaction - just observe. Windsurf status survives via appendEntry.
    // The session_compact handler will re-inject status after compaction.
  });

  // -- session_compact: re-inject Windsurf status after compaction --
  pi.on("session_compact", async (event, ctx) => {
    if (ctx.model?.provider !== "windsurf") return;
    // After compaction, the LLM loses context about Windsurf plan/quota.
    // Re-inject via sendMessage so the LLM has this info in the new context.
    const c = loadCredentials();
    if (!c) return;
    try {
      const status = await getUserStatus(c.apiKey, c.apiServerUrl);
      const parts: string[] = [];
      if (status.planName) parts.push(`Plan: ${status.planName}`);
      if (status.availablePromptCredits !== undefined) parts.push(`Credits: ${status.availablePromptCredits}/${status.monthlyPromptCredits ?? "?"}`);
      if (status.dailyQuotaRemainingPercent !== undefined) parts.push(`Daily: ${status.dailyQuotaRemainingPercent}%`);
      if (parts.length > 0) {
        pi.sendMessage({
          customType: "windsurf-context",
          content: `After compaction: Windsurf ${parts.join(", ")}.`,
          display: false,
        }, { deliverAs: "followUp" });
      }
    } catch {}
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("windsurf", undefined);
    _pi = null;
    _lastStatusEntry = null;
    windsurfEventBus.dispose();
    stopProxy();
  });
}
