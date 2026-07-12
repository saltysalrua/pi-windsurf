/**
 * Windsurf Provider for Pi
 *
 * Enables Windsurf/Cognition models via cloud-direct API.
 * Models are fetched dynamically from GetCliModelConfigs (Devin CLI endpoint).
 *
 * Usage: /login windsurf → /model windsurf/<id>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	ThinkingLevel,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	startProxy,
	stopProxy,
	PROXY_SECRET,
	setProxyCredentials,
	getResponseMeta,
	serializeResponseMeta,
	getChildProxyUrl,
} from "./proxy";
import {
	loadCredentials,
	saveCredentials,
	deleteCredentials,
	loadApiFormat,
	saveApiFormat,
	DEFAULT_REGION,
	runLoginLoopback,
	registerUser,
	type PersistedCredentials,
	type WindsurfApiFormat,
} from "./oauth";
import { clearCachedUserJwt } from "./auth";
import { clearSessionIds } from "./chat";
import { getPricingForModelUid } from "./pricing";
import {
	clearCachedCatalog,
	getCachedCatalog,
	type ModelCatalogEntry,
	type ModelFeatures,
} from "./catalog";
import { getUserStatus, clearAssignmentCache } from "./assign";
import { windsurfEventBus } from "./event-log";

let _pi: ExtensionAPI | null = null;
let _apiKey = "";
let _apiServerUrl = "https://server.self-serve.windsurf.com";

// ----------------------------------------------------------------------------
// Model grouping: collapse per-thinking-level catalog entries into one Pi model
// with a native thinking-level selector.
//
// Windsurf's catalog lists every thinking level (Low/Medium/High/XHigh/Max) and
// Fast variant as a SEPARATE entry with its own UID. The modelFamilyUid field
// (proto #26) is useless on self-serve — it equals each entry's own UID, so
// every "family" has exactly 1 member.
//
// We group by stripping the thinking-level and fast suffixes from the UID to
// derive a family key, then emit one Pi model per (family × speed) combination.
// Pi's native thinkingLevelMap maps each level to the corresponding catalog UID.
// ----------------------------------------------------------------------------

/** Suffix patterns that encode thinking level in the UID. */
const UID_LEVEL_SUFFIXES: [ThinkingLevel | "off", RegExp][] = [
	["off", /-none$/],
	["minimal", /-minimal$/],
	["low", /-low$/],
	["medium", /-medium$/],
	["high", /-high$/],
	["xhigh", /-xhigh$/],
	["max", /-max$/],
];

/** Fast/priority suffix — separates normal and fast into distinct Pi models. */
const UID_FAST_SUFFIX = /-(?:fast|priority)$/;

interface GroupedModel {
	/** Family key (UID with level + fast suffixes stripped). */
	familyKey: string;
	/** Display name without the thinking-level word. */
	baseLabel: string;
	/** Whether this is the fast variant. */
	isFast: boolean;
	/** Map thinking level → catalog UID. */
	levelToUid: Map<ThinkingLevel | "off", string>;
	/** All catalog entries in this group (for metadata aggregation). */
	entries: ModelCatalogEntry[];
}

/** Strip thinking-level and fast suffixes from a UID to get the family key. */
function stripLevelAndFast(uid: string): {
	familyKey: string;
	level: ThinkingLevel | "off" | null;
	isFast: boolean;
} {
	let isFast = false;
	let work = uid;
	if (UID_FAST_SUFFIX.test(work)) {
		isFast = true;
		work = work.replace(UID_FAST_SUFFIX, "");
	}
	let level: ThinkingLevel | "off" | null = null;
	for (const [lvl, re] of UID_LEVEL_SUFFIXES) {
		if (re.test(work)) {
			level = lvl;
			work = work.replace(re, "");
			break;
		}
	}
	return { familyKey: work, level, isFast };
}

/** Strip the thinking-level word and Fast/Thinking suffixes from a display label.
 *  Order matters: remove "Fast" and "Thinking"/"No Thinking" first (they come
 *  after the level word), then the level words themselves, then "1M". */
function stripLevelFromLabel(label: string): string {
	return label
		.replace(/\s+Fast$/i, "")
		.replace(/\s+No\s+Thinking$/i, "")
		.replace(/\s+Thinking$/i, "")
		.replace(/\s+Minimal$/i, "")
		.replace(/\s+Low$/i, "")
		.replace(/\s+Medium$/i, "")
		.replace(/\s+High$/i, "")
		.replace(/\s+XHigh$/i, "")
		.replace(/\s+X-High$/i, "")
		.replace(/\s+Max$/i, "")
		.replace(/\s+1M$/i, "")
		.trim();
}

/** Group catalog entries into families with thinking-level maps. */
function groupCatalogEntries(entries: ModelCatalogEntry[]): GroupedModel[] {
	const groups = new Map<string, GroupedModel>();

	for (const entry of entries) {
		const { familyKey, level, isFast } = stripLevelAndFast(entry.modelUid);
		// For entries with no level suffix (single-variant models), familyKey = uid
		const groupKey = `${familyKey}__${isFast ? "fast" : "normal"}`;

		let group = groups.get(groupKey);
		if (!group) {
			group = {
				familyKey,
				baseLabel: stripLevelFromLabel(entry.label),
				isFast,
				levelToUid: new Map(),
				entries: [],
			};
			groups.set(groupKey, group);
		}
		group.entries.push(entry);
		if (level) {
			group.levelToUid.set(level, entry.modelUid);
		} else {
			// No level suffix — this is a single-variant model, map as "off"
			group.levelToUid.set("off", entry.modelUid);
		}
	}

	return [...groups.values()];
}

/** Build a Pi thinkingLevelMap from a grouped model's level→UID mapping. */
function buildGroupedThinkingLevelMap(
	group: GroupedModel,
): ThinkingLevelMap | undefined {
	if (group.levelToUid.size <= 1 && !group.levelToUid.has("off"))
		return undefined;
	// If only "off" exists, it's a single-variant model with no thinking selector
	if (group.levelToUid.size === 1 && group.levelToUid.has("off"))
		return undefined;

	const map: ThinkingLevelMap = {};
	const allLevels: (ThinkingLevel | "off")[] = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	for (const lvl of allLevels) {
		const uid = group.levelToUid.get(lvl);
		if (uid) {
			map[lvl] = uid;
		} else {
			map[lvl] = null;
		}
	}
	return map;
}

/** Build a Pi model definition from a grouped model. */
function groupedModelToPi(group: GroupedModel) {
	// Aggregate metadata from entries: use the first entry for most fields,
	// but take the max contextWindow / maxOutputTokens across the group.
	const first = group.entries[0];
	const ctx = Math.max(...group.entries.map((e) => e.contextWindow ?? 0));
	const maxOut = Math.max(...group.entries.map((e) => e.maxOutputTokens ?? 0));

	// Determine free/promo status across the group
	const allFree = group.entries.every((e) => !e.hasPricing);
	const anyPromo = group.entries.some((e) => e.promoActive);
	const allPromo = group.entries.every((e) => e.promoActive);
	const somePromo = anyPromo && !allPromo; // only some levels are promo

	const tags: string[] = [];
	if (allPromo) tags.push("Free Promo");
	else if (somePromo) tags.push("Some Free Promo");
	else if (allFree) tags.push("Free");
	if (first.isNew) tags.push("New");
	if (first.isModelRouter) tags.push("Router");
	if (group.isFast) tags.push("Fast");
	const tagStr = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
	const ctxStr =
		ctx > 0
			? ` (${ctx >= 1_000_000 ? `${Math.round(ctx / 1_000_000)}M` : `${Math.round(ctx / 1_000)}K`})`
			: "";

	const f = first.features;
	const pricing = getPricingForModelUid(group.familyKey);

	// Use the family key as the model id. Pi will send thinkingLevelMap[level]
	// (the specific UID) when the user selects a thinking level, or the family
	// key itself if no level is selected (resolveModelName handles fallback).
	const modelId = group.familyKey;

	return {
		id: modelId,
		name: `${group.baseLabel}${tagStr}${ctxStr}`,
		reasoning: f?.supportsThinking ?? true,
		thinkingLevelMap: buildGroupedThinkingLevelMap(group),
		input: [
			"text",
			...(f?.supportsImageCaptions !== false ? ["image"] : []),
		] as ("text" | "image")[],
		cost: {
			input: pricing.input,
			output: pricing.output,
			cacheRead: pricing.cacheRead,
			cacheWrite: pricing.cacheWrite,
		},
		contextWindow: ctx || 1,
		maxTokens: maxOut || 1,
	};
}

/** Fetch catalog and build dynamic model list. */
async function fetchDynamicModels(
	apiKey: string,
	apiServerUrl: string,
): Promise<ReturnType<typeof groupedModelToPi>[]> {
	try {
		const catalog = await getCachedCatalog(apiKey, apiServerUrl);
		if (catalog && catalog.byUid.size > 0) {
			const entries = [...catalog.byUid.values()].filter((m) => !m.disabled);
			const groups = groupCatalogEntries(entries);
			return groups.map((g) => groupedModelToPi(g));
		}
	} catch {}
	return [];
}

// OAuth
async function loginWindsurf(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	let token: string;
	try {
		token = await runLoginLoopback(DEFAULT_REGION, (url) =>
			callbacks.onAuth({ url }),
		);
	} catch {
		const pasted = await callbacks.onPrompt({
			message: `Open this URL, sign in, paste callback URL or token:\n\n  ${DEFAULT_REGION.website}/windsurf/signin\n\nPaste:`,
		});
		const trimmed = pasted.trim();
		try {
			const u = new URL(trimmed);
			token =
				u.searchParams.get("firebase_id_token") ??
				u.searchParams.get("access_token") ??
				u.searchParams.get("token") ??
				trimmed;
		} catch {
			token = trimmed;
		}
	}
	if (!token) throw new Error("No token received.");

	const result = await registerUser(token, DEFAULT_REGION);
	saveCredentials({
		...result,
		issuedAt: new Date().toISOString(),
		oauthClientId: DEFAULT_REGION.oauthClientId,
	});
	setProxyCredentials({
		apiKey: result.apiKey,
		apiServerUrl: result.apiServerUrl,
	});
	clearCachedUserJwt();
	clearSessionIds();
	clearCachedCatalog();
	return {
		refresh: result.apiKey,
		access: result.apiKey,
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	};
}

async function refreshWindsurfToken(
	c: OAuthCredentials,
): Promise<OAuthCredentials> {
	return c;
}

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
			setProxyCredentials({
				apiKey: stored.apiKey,
				apiServerUrl: stored.apiServerUrl,
			});
			hasCreds = true;
			_apiKey = stored.apiKey;
			_apiServerUrl = stored.apiServerUrl;
		}
	} catch {}

	// Fetch models dynamically from catalog
	const models = hasCreds
		? await fetchDynamicModels(_apiKey, _apiServerUrl)
		: [];

	let apiFormat: WindsurfApiFormat = loadApiFormat();
	const registerWindsurfProvider = (format: WindsurfApiFormat): void => {
		const isAnthropic = format === "anthropic";
		pi.registerProvider("windsurf", {
			name: "Cognition (Windsurf)",
			baseUrl: isAnthropic ? anthropicBaseUrl : baseUrl,
			apiKey: providerApiKey,
			api: isAnthropic ? "anthropic-messages" : "openai-completions",
			authHeader: true,
			models,
			compat: {
				supportsDeveloperRole: !isAnthropic,
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
	};

	registerWindsurfProvider(apiFormat);

	pi.registerCommand("windsurf-api", {
		description: "Switch Windsurf API format",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify(
					`Current: ${apiFormat}. Use /windsurf-api ${apiFormat === "openai" ? "anthropic" : "openai"} to switch.`,
					"info",
				);
				return;
			}
			if (requested !== "openai" && requested !== "anthropic") {
				ctx.ui.notify("Usage: /windsurf-api openai|anthropic", "warning");
				return;
			}
			if (requested === apiFormat) {
				ctx.ui.notify(`Windsurf API format is already ${apiFormat}.`, "info");
				return;
			}
			try {
				saveApiFormat(requested);
				apiFormat = requested;
				pi.unregisterProvider("windsurf");
				registerWindsurfProvider(apiFormat);
				ctx.ui.notify(
					`Windsurf API format switched to ${apiFormat}. If your selected model doesn't switch, restart Pi.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Failed to switch Windsurf API format: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
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
				parts.push(
					status.planName ? `Plan: ${status.planName}` : "Plan: unknown",
				);
				if (status.isPro) parts.push("Pro");
				if (status.isTeams) parts.push("Teams");
				if (status.isEnterprise) parts.push("Enterprise");
				if (status.availablePromptCredits !== undefined)
					parts.push(
						`Credits: ${status.availablePromptCredits}/${status.monthlyPromptCredits ?? "?"} prompts`,
					);
				if (status.availableFlowCredits !== undefined)
					parts.push(
						`Flow: ${status.availableFlowCredits}/${status.monthlyFlowCredits ?? "?"}`,
					);
				if (status.dailyQuotaRemainingPercent !== undefined)
					parts.push(`Daily: ${status.dailyQuotaRemainingPercent}%`);
				if (status.weeklyQuotaRemainingPercent !== undefined)
					parts.push(`Weekly: ${status.weeklyQuotaRemainingPercent}%`);
				if (status.canUseCascade === false) parts.push("Cascade: disabled");
				if (status.canUseCli === false) parts.push("CLI: disabled");
				ctx.ui.notify(`Windsurf: ${parts.join(" | ")}`, "info");
			} catch (e) {
				ctx.ui.notify(
					`Windsurf: authenticated (${c.apiServerUrl}) but status fetch failed: ${e instanceof Error ? e.message : String(e)}`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("windsurf-logout", {
		description: "Sign out of Windsurf",
		handler: async (_args, ctx) => {
			const ok = deleteCredentials();
			setProxyCredentials(null);
			clearCachedUserJwt();
			clearSessionIds();
			clearCachedCatalog();
			clearAssignmentCache();
			pi.unregisterProvider("windsurf");
			ctx.ui.notify(
				ok ? "Windsurf: signed out." : "Already signed out.",
				"info",
			);
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
					ctx.ui.notify(
						`Windsurf: refreshed ${catalog.byUid.size} models. Restart Pi to apply.`,
						"info",
					);
				} else {
					ctx.ui.notify(
						"Windsurf: refresh failed. Check connection.",
						"warning",
					);
				}
			} catch (e) {
				ctx.ui.notify(
					`Windsurf: refresh error - ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		},
	});

	// -- registerTool: windsurf_status — LLM-callable tool to query plan/quota --
	pi.registerTool({
		name: "windsurf_status",
		label: "Windsurf Status",
		description:
			"Query current Windsurf account status: plan, credits, daily/weekly quota, and feature availability.",
		promptSnippet: "Query Windsurf account status (plan, credits, quota)",
		promptGuidelines: [
			"Use windsurf_status when the user asks about their Windsurf plan, credits, quota, or account status.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const c = loadCredentials();
			if (!c) {
				return {
					content: [
						{
							type: "text",
							text: "Not signed in to Windsurf. Run /login windsurf first.",
						},
					],
					details: {},
				};
			}
			try {
				const status = await getUserStatus(c.apiKey, c.apiServerUrl);
				const lines: string[] = [];
				lines.push(
					`Plan: ${status.planName ?? "unknown"}${status.isPro ? " (Pro)" : ""}${status.isTeams ? " (Teams)" : ""}${status.isEnterprise ? " (Enterprise)" : ""}`,
				);
				if (
					status.availablePromptCredits !== undefined &&
					status.monthlyPromptCredits !== undefined
				) {
					lines.push(
						`Prompt credits: ${status.availablePromptCredits} / ${status.monthlyPromptCredits}`,
					);
				}
				if (
					status.availableFlowCredits !== undefined &&
					status.monthlyFlowCredits !== undefined
				) {
					lines.push(
						`Flow credits: ${status.availableFlowCredits} / ${status.monthlyFlowCredits}`,
					);
				}
				if (status.dailyQuotaRemainingPercent !== undefined) {
					lines.push(
						`Daily quota: ${status.dailyQuotaRemainingPercent}% remaining`,
					);
				}
				if (status.weeklyQuotaRemainingPercent !== undefined) {
					lines.push(
						`Weekly quota: ${status.weeklyQuotaRemainingPercent}% remaining`,
					);
				}
				if (status.canUseCascade === false) lines.push("Cascade: disabled");
				if (status.canUseCli === false) lines.push("CLI: disabled");
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {},
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch Windsurf status: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: {},
				};
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
		if (
			event.reason === "resume" ||
			event.reason === "reload" ||
			event.reason === "new" ||
			event.reason === "fork"
		) {
			const c = loadCredentials();
			if (c) {
				setProxyCredentials({ apiKey: c.apiKey, apiServerUrl: c.apiServerUrl });
				_apiKey = c.apiKey;
				_apiServerUrl = c.apiServerUrl;
				// Restore persisted status from session entries
				for (const entry of ctx.sessionManager.getEntries()) {
					if (
						entry.type === "custom" &&
						entry.customType === "windsurf-status"
					) {
						_lastStatusEntry = entry.data as Record<string, unknown>;
					}
				}
				// Fetch fresh status in background
				refreshAndPersistStatus();
			}
		}
	});

	// -- messageRenderer: Windsurf context messages in chat transcript --
	pi.registerMessageRenderer(
		"windsurf-context",
		(message, { expanded }, theme) => {
			const content = message.content || "";
			const details = (message as any).details as
				| Record<string, unknown>
				| undefined;
			const isRateLimit =
				content.includes("429") || content.includes("rate limit");
			const isServerError =
				content.includes("500") || content.includes("server error");
			const lines: string[] = [];
			if (isRateLimit) {
				const retryAfter = details?.retryAfter
					? String(details.retryAfter)
					: null;
				lines.push(
					theme.fg("warning", "[rate limit]") + " " + theme.fg("dim", content),
				);
				if (expanded && retryAfter) {
					lines.push(theme.fg("dim", `  Retry after: ${retryAfter}s`));
					lines.push(theme.fg("dim", `  Suggestion: switch model or wait`));
				}
			} else if (isServerError) {
				lines.push(
					theme.fg("error", "[server error]") + " " + theme.fg("dim", content),
				);
			} else {
				lines.push(
					theme.fg("muted", "[windsurf]") + " " + theme.fg("dim", content),
				);
			}
			return { render: () => lines, invalidate: () => {} };
		},
	);

	// -- show resolved model info in the status bar + emit event --
	// Check if a model+thinking-level combination is free-promo in the catalog.
	// Returns { promo: boolean, free: boolean } or null if catalog unavailable.
	async function checkFreePromo(
		modelId: string,
		thinkingLevel: string | undefined,
	): Promise<{ promo: boolean; free: boolean } | null> {
		try {
			const catalog = await getCachedCatalog(_apiKey, _apiServerUrl);
			if (!catalog) return null;
			// Resolve modelId + thinkingLevel to a specific catalog UID
			const { resolveModelName } = await import("./models");
			const resolved = await resolveModelName(modelId, _apiKey, _apiServerUrl, thinkingLevel);
			const entry = catalog.byUid.get(resolved.modelUid);
			if (!entry) return null;
			return { promo: !!entry.promoActive, free: !entry.hasPricing };
		} catch {
			return null;
		}
	}

	// Update status bar with model + free-promo indicator
	async function updateWindsurfStatus(
		ctx: Parameters<Parameters<typeof _pi.on>[1]>[1],
		modelId: string,
		thinkingLevel?: string,
	) {
		const levelStr = thinkingLevel ? ` · ${thinkingLevel}` : "";
		const promoInfo = await checkFreePromo(modelId, thinkingLevel);
		let suffix = "";
		if (promoInfo?.promo) suffix = " · 🆓 Free Promo";
		else if (promoInfo?.free) suffix = " · 🆓 Free";
		ctx.ui.setStatus("windsurf", `${modelId}${levelStr}${suffix}`);
	}

	pi.on("model_select", async (event, ctx) => {
		const m = event.model;
		if (m?.id && m.provider === "windsurf") {
			const level = pi.getThinkingLevel();
			await updateWindsurfStatus(ctx, m.id, level);
			windsurfEventBus.emit("windsurf:model_select", { modelId: m.id });
			pi.events.emit("windsurf:model_select", { modelId: m.id });
		}
	});

	// -- show thinking level in status bar + emit event --
	pi.on("thinking_level_select", async (event, ctx) => {
		if (ctx.model?.provider === "windsurf") {
			const level = event.level;
			await updateWindsurfStatus(ctx, ctx.model?.id ?? "?", level);
			windsurfEventBus.emit("windsurf:thinking_level", {
				level,
				modelId: ctx.model?.id,
			});
			pi.events.emit("windsurf:thinking_level", {
				level,
				modelId: ctx.model?.id,
			});
		}
	});

	// Show thinking status during requests, clear on completion
	pi.on("before_provider_request", async (_event, ctx) => {
		if (ctx.model?.provider === "windsurf") {
			const usage = ctx.getContextUsage();
			const tokens = usage ? `${Math.round(usage.tokens / 1000)}K` : "";
			ctx.ui.setWorkingMessage(
				`windsurf ${ctx.model.id}${tokens ? ` (${tokens})` : ""} ...`,
			);
		}
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (ctx.model?.provider !== "windsurf") return;
		ctx.ui.setWorkingMessage();
		if (event.status === 429) {
			const retryAfter = event.headers?.["retry-after"];
			ctx.ui.notify(
				`Windsurf rate limited. Retry after ${retryAfter ?? "?"}s`,
				"warning",
			);
			windsurfEventBus.emit("windsurf:error", {
				type: "rate_limit",
				status: 429,
				retryAfter,
			});
			pi.events.emit("windsurf:error", {
				type: "rate_limit",
				status: 429,
				retryAfter,
			});
			pi.sendMessage(
				{
					customType: "windsurf-context",
					content: `Windsurf API returned 429 rate limit. ${retryAfter ? `Retry after ${retryAfter}s.` : "Wait before retrying."} Reduce request frequency or switch to a different model.`,
					display: false,
					details: {
						type: "rate_limit",
						status: 429,
						retryAfter: retryAfter ?? null,
						model: ctx.model?.id ?? null,
					},
				},
				{ deliverAs: "followUp" },
			);
		} else if (event.status >= 500) {
			ctx.ui.notify(`Windsurf server error: ${event.status}`, "error");
			windsurfEventBus.emit("windsurf:error", {
				type: "server_error",
				status: event.status,
			});
			pi.events.emit("windsurf:error", {
				type: "server_error",
				status: event.status,
			});
		} else if (event.status >= 400) {
			windsurfEventBus.emit("windsurf:error", {
				type: "client_error",
				status: event.status,
			});
			pi.events.emit("windsurf:error", {
				type: "client_error",
				status: event.status,
			});
		}
	});

	// Attach Windsurf response metadata to assistant messages.
	// Pi's AssistantMessage doesn't preserve custom fields from the provider response,
	// so the proxy stores metadata in a side channel keyed by responseId.
	pi.on("message_end", async (event, ctx) => {
		if (
			event.message.role !== "assistant" ||
			ctx.model?.provider !== "windsurf"
		)
			return;
		const responseId = (event.message as any).responseId as string | undefined;
		if (!responseId) return;
		const meta = getResponseMeta(responseId);
		if (!meta) return;
		return {
			message: {
				...event.message,
				metadata: {
					...(event.message as any).metadata,
					windsurf: serializeResponseMeta(meta),
				},
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
			if (status.availablePromptCredits !== undefined)
				parts.push(
					`Credits: ${status.availablePromptCredits}/${status.monthlyPromptCredits ?? "?"}`,
				);
			if (status.dailyQuotaRemainingPercent !== undefined)
				parts.push(`Daily: ${status.dailyQuotaRemainingPercent}%`);
			if (parts.length > 0) {
				pi.sendMessage(
					{
						customType: "windsurf-context",
						content: `After compaction: Windsurf ${parts.join(", ")}.`,
						display: false,
					},
					{ deliverAs: "followUp" },
				);
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
