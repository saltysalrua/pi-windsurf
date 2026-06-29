/**
 * Per-account model catalog from Cognition's Devin CLI endpoints.
 *
 * Uses GetCliModelConfigs (same as Devin CLI) instead of GetCascadeModelConfigs.
 * Fetches live model list at startup and after login. Used for:
 *   1. Dynamic model registration (new models appear automatically)
 *   2. Pre-flight availability check (reject disabled models before wasting a roundtrip)
 */
import * as crypto from "crypto";
import { buildMetadata } from "./metadata";
import { getCachedUserJwt, clearCachedUserJwt } from "./auth";
import { encodeMessage, iterFields } from "./wire";
import { clearSessionIds } from "./chat";

const CATALOG_TTL_MS = 10 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

export interface ModelFeatures {
  supportsThinking?: boolean;
  interleaveThinking?: boolean;
  preserveThinking?: boolean;
  supportsToolCalls?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsImageCaptions?: boolean;
  requiresInstructTags?: boolean;
  supportsRejectionContext?: boolean;
  supportsCumulativeContext?: boolean;
  supportsContextTokens?: boolean;
  zeroShotCapable?: boolean;
  supportsEstimateTokenCount?: boolean;
  requiresContextRelevanceTags?: boolean;
  requiresContextSnippetPrefix?: boolean;
  requiresSupercompleteClean?: boolean;
  requiresLlama3Tokens?: boolean;
  requiresFimContext?: boolean;
  tabRouteToModal?: boolean;
  tabJumpPrintLineRange?: boolean;
  supportsCursorAwareSupercomplete?: boolean;
  addCursorToFindReplaceTarget?: boolean;
}

export type InferenceConfig =
  | { kind: "anthropic"; effort?: string; thinking?: string; fastMode?: boolean; context1m?: boolean }
  | { kind: "google"; reasoningEffort?: string; reasoningContext?: string }
  | { kind: "openai"; extendedPromptCacheRetention?: number; serviceTier?: string }
  | { kind: "none" };

export interface ModelCatalogEntry {
  modelUid: string;
  label: string;
  disabled: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  description?: string;
  provider?: number;
  creditMultiplier?: number;
  isPremium?: boolean;
  isNew?: boolean;
  isModelRouter?: boolean;
  modelFamilyUid?: string;
  inferenceConfig?: InferenceConfig;
  features?: ModelFeatures;
  promoActive?: boolean;
  promoLabel?: string;
  promoEndDate?: string;
  hasPricing: boolean;
}

interface CacheEntry {
  byUid: Map<string, ModelCatalogEntry>;
  fetchedAt: number;
  apiKey: string;
  host: string;
}

let cached: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;
let inFlightKey: string | null = null;

function flightKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`;
}

async function fetchAllowedModelUids(apiKey: string, host: string, jwt: string, signal?: AbortSignal): Promise<Set<string>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`team settings timeout (${CATALOG_FETCH_TIMEOUT_MS}ms)`)), CATALOG_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    const metadata = buildMetadata({
      apiKey, userJwt: jwt,
      sessionId: crypto.randomUUID(),
      requestId: BigInt(Date.now()),
      triggerId: crypto.randomUUID(),
    });
    resp = await fetch(`${host}/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings`, {
      method: "POST",
      headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
      body: encodeMessage(1, metadata),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) return new Set();
  const buf = Buffer.from(await resp.arrayBuffer());

  const uids = new Set<string>();
  for (const f of iterFields(buf)) {
    if (f.num !== 1 || f.wire !== 2 || !Buffer.isBuffer(f.value)) continue;
    for (const sf of iterFields(f.value as Buffer)) {
      if (sf.num === 7 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        for (const ssf of iterFields(sf.value as Buffer)) {
          if (ssf.wire === 2 && Buffer.isBuffer(ssf.value)) {
            const uid = (ssf.value as Buffer).toString("utf8");
            if (uid.length > 0) uids.add(uid);
          }
        }
      }
    }
  }
  return uids;
}

async function fetchCatalog(apiKey: string, host: string, signal?: AbortSignal): Promise<CacheEntry> {
  const userJwt = await getCachedUserJwt(apiKey, host, signal);

  // Fetch both endpoints in parallel: CLI model configs for metadata, team settings for allowed UIDs
  const [cliModelResp, allowedUids] = await Promise.all([
    (async () => {
      const metadata = buildMetadata({
        apiKey, userJwt,
        sessionId: crypto.randomUUID(),
        requestId: BigInt(Date.now()),
        triggerId: crypto.randomUUID(),
      });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`catalog fetch timeout (${CATALOG_FETCH_TIMEOUT_MS}ms)`)), CATALOG_FETCH_TIMEOUT_MS);
      try {
        const r = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`, {
          method: "POST",
          headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
          body: encodeMessage(1, metadata),
          signal: ac.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    })(),
    fetchAllowedModelUids(apiKey, host, userJwt, signal),
  ]);

  // Phase 1: Build metadata map from CLI model config entries (label → metadata)
  const cliByLabel = new Map<string, { modelUid: string; disabled: boolean; contextWindow?: number; maxOutputTokens?: number; description?: string; provider?: number; creditMultiplier?: number; isPremium?: boolean; isNew?: boolean; isModelRouter?: boolean; modelFamilyUid?: string; inferenceConfig?: InferenceConfig; features?: ModelFeatures; promoActive?: boolean; promoLabel?: string; promoEndDate?: string; hasPricing: boolean }>();
  const cliByEnum = new Map<number, { label: string; modelUid: string; disabled: boolean; contextWindow?: number; maxOutputTokens?: number; description?: string; provider?: number; creditMultiplier?: number; isPremium?: boolean; isNew?: boolean; isModelRouter?: boolean; modelFamilyUid?: string; inferenceConfig?: InferenceConfig; features?: ModelFeatures; promoActive?: boolean; promoLabel?: string; promoEndDate?: string; hasPricing: boolean }>();
  const cliByF22 = new Map<string, { label: string; disabled: boolean; contextWindow?: number; maxOutputTokens?: number; description?: string; provider?: number; creditMultiplier?: number; isPremium?: boolean; isNew?: boolean; isModelRouter?: boolean; modelFamilyUid?: string; inferenceConfig?: InferenceConfig; features?: ModelFeatures; promoActive?: boolean; promoLabel?: string; promoEndDate?: string; hasPricing: boolean }>();

  for (const f of iterFields(cliModelResp)) {
    if (f.num !== 1 || f.wire !== 2 || !Buffer.isBuffer(f.value)) continue;
    let label = ""; let modelUid = ""; let disabled = false; let enumVal = 0;
    let contextWindow: number | undefined; let maxOutputTokens: number | undefined;
    let description: string | undefined; let provider: number | undefined;
    let creditMultiplier: number | undefined; let isPremium: boolean | undefined; let isNew: boolean | undefined;
    let promoActive: boolean | undefined; let promoLabel: string | undefined; let promoEndDate: string | undefined;
    let hasPricing = false;
    let isModelRouter: boolean | undefined;
    let modelFamilyUid: string | undefined;
    let features: ModelFeatures | undefined;
    let inferenceConfig: InferenceConfig | undefined;
    for (const sf of iterFields(f.value as Buffer)) {
      if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) label = (sf.value as Buffer).toString("utf8");
      else if (sf.num === 4 && sf.wire === 0) disabled = sf.value === 1n;
      else if (sf.num === 22 && sf.wire === 2 && Buffer.isBuffer(sf.value)) modelUid = (sf.value as Buffer).toString("utf8");
      else if (sf.num === 3 && sf.wire === 0) creditMultiplier = Number(sf.value);
      else if (sf.num === 7 && sf.wire === 0) isPremium = sf.value === 1n;
      else if (sf.num === 15 && sf.wire === 0) isNew = sf.value === 1n;
      else if (sf.num === 2 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        for (const ssf of iterFields(sf.value as Buffer)) { if (ssf.num === 1 && ssf.wire === 0) enumVal = Number(ssf.value); }
      } else if (sf.num === 18 && sf.wire === 0) contextWindow = Number(sf.value);
      else if (sf.num === 8 && sf.wire === 2 && Buffer.isBuffer(sf.value)) description = (sf.value as Buffer).toString("utf8");
      else if (sf.num === 24 && sf.wire === 0) provider = Number(sf.value);
      else if (sf.num === 32 && sf.wire === 2) hasPricing = true;
      else if (sf.num === 6 && sf.wire === 2 && Buffer.isBuffer(sf.value)) features = decodeModelFeatures(sf.value as Buffer);
      else if (sf.num === 23 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        const sub = decodeInferenceConfig(sf.value as Buffer);
        if (sub) { inferenceConfig = sub; }
        for (const ssf of iterFields(sf.value as Buffer)) { if (ssf.num === 13 && ssf.wire === 0) maxOutputTokens = Number(ssf.value); }
      } else if (sf.num === 25 && sf.wire === 0) isModelRouter = sf.value === 1n;
      else if (sf.num === 26 && sf.wire === 2 && Buffer.isBuffer(sf.value)) modelFamilyUid = (sf.value as Buffer).toString("utf8");
      else if (sf.num === 19 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        for (const pf of iterFields(sf.value as Buffer)) {
          if (pf.num === 1 && pf.wire === 0) promoActive = pf.value === 1n;
          else if (pf.num === 3 && pf.wire === 2 && Buffer.isBuffer(pf.value)) promoLabel = (pf.value as Buffer).toString("utf8");
          else if (pf.num === 2 && pf.wire === 2 && Buffer.isBuffer(pf.value)) {
            let seconds = 0n;
            for (const tf of iterFields(pf.value as Buffer)) { if (tf.num === 1 && tf.wire === 0) seconds = tf.value; }
            if (seconds > 0n) promoEndDate = new Date(Number(seconds) * 1000).toISOString();
          }
        }
      }
    }
    const meta = { modelUid, disabled, contextWindow, maxOutputTokens, description, provider, creditMultiplier, isPremium, isNew, isModelRouter, modelFamilyUid, inferenceConfig, features, promoActive, promoLabel, promoEndDate, hasPricing };
    if (label) cliByLabel.set(label, meta);
    if (enumVal > 0) cliByEnum.set(enumVal, { label, ...meta });
    if (modelUid) cliByF22.set(modelUid, { label, ...meta });
  }

  // Phase 2: Register every allowed UID from team settings
  const byUid = new Map<string, ModelCatalogEntry>();
  for (const uid of allowedUids) {
    // Try to find metadata from CLI model configs: f22 match > label match > enum match
    let meta = cliByF22.get(uid);
    if (!meta) {
      // Check if uid matches a CLI label directly
      const byLabel = cliByLabel.get(uid);
      if (byLabel) meta = { label: uid, ...byLabel };
    }
    if (!meta) {
      // Check if uid matches an enum-mapped name (e.g. MODEL_CLAUDE_4_5_OPUS)
      for (const [, entry] of cliByEnum) {
        if (entry.modelUid === uid || entry.label === uid) { meta = entry; break; }
      }
    }
    byUid.set(uid, {
      modelUid: uid,
      label: meta?.label || uid,
      disabled: meta?.disabled ?? false,
      contextWindow: meta?.contextWindow,
      maxOutputTokens: meta?.maxOutputTokens,
      description: meta?.description,
      provider: meta?.provider,
      creditMultiplier: meta?.creditMultiplier,
      isPremium: meta?.isPremium,
      isNew: meta?.isNew,
      isModelRouter: meta?.isModelRouter,
      modelFamilyUid: meta?.modelFamilyUid,
      inferenceConfig: meta?.inferenceConfig,
      features: meta?.features,
      promoActive: meta?.promoActive,
      promoLabel: meta?.promoLabel,
      promoEndDate: meta?.promoEndDate,
      hasPricing: meta?.hasPricing ?? false,
    });
  }

  // Phase 3: Also add CLI model config entries not in allowed list (may still work via label passthrough)
  for (const [uid, meta] of cliByF22) {
    if (!byUid.has(uid)) {
      byUid.set(uid, { modelUid: uid, label: meta.label || uid, disabled: meta.disabled, contextWindow: meta.contextWindow, maxOutputTokens: meta.maxOutputTokens, description: meta.description, provider: meta.provider, creditMultiplier: meta.creditMultiplier, isPremium: meta.isPremium, isNew: meta.isNew, isModelRouter: meta.isModelRouter, modelFamilyUid: meta.modelFamilyUid, inferenceConfig: meta.inferenceConfig, features: meta.features, promoActive: meta.promoActive, promoLabel: meta.promoLabel, promoEndDate: meta.promoEndDate, hasPricing: meta.hasPricing });
    }
  }

  return { byUid, fetchedAt: Date.now(), apiKey, host };
}

export async function getCachedCatalog(
  apiKey: string,
  host: string,
  signal?: AbortSignal,
): Promise<CacheEntry | null> {
  if (cached && cached.apiKey === apiKey && cached.host === host) {
    if (Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
  }

  const key = flightKey(apiKey, host);
  if (inFlight && inFlightKey === key) {
    try { return await inFlight; } catch { return null; }
  }

  const promise = fetchCatalog(apiKey, host, signal);
  inFlight = promise;
  inFlightKey = key;
  try {
    const result = await promise;
    cached = result;
    return result;
  } catch {
    return null;
  } finally {
    if (inFlight === promise) { inFlight = null; inFlightKey = null; }
  }
}

export function clearCachedCatalog(): void {
  cached = null;
  inFlight = null;
  inFlightKey = null;
}

// ----------------------------------------------------------------------------
// Proto decoders for ModelFeatures + InferenceConfig
// ----------------------------------------------------------------------------

function decodeModelFeatures(buf: Buffer): ModelFeatures {
  const f: ModelFeatures = {};
  for (const sf of iterFields(buf)) {
    if (sf.wire !== 0) continue;
    const v = sf.value === 1n;
    switch (sf.num) {
      case 1: f.supportsThinking = v; break;
      case 2: f.interleaveThinking = v; break;
      case 3: f.preserveThinking = v; break;
      case 4: f.supportsToolCalls = v; break;
      case 5: f.supportsParallelToolCalls = v; break;
      case 6: f.supportsImageCaptions = v; break;
      case 7: f.requiresInstructTags = v; break;
      case 8: f.supportsRejectionContext = v; break;
      case 9: f.supportsCumulativeContext = v; break;
      case 10: f.supportsContextTokens = v; break;
      case 11: f.zeroShotCapable = v; break;
      case 12: f.supportsEstimateTokenCount = v; break;
      case 13: f.requiresContextRelevanceTags = v; break;
      case 14: f.requiresContextSnippetPrefix = v; break;
      case 15: f.requiresSupercompleteClean = v; break;
      case 16: f.requiresLlama3Tokens = v; break;
      case 17: f.requiresFimContext = v; break;
      case 18: f.tabRouteToModal = v; break;
      case 19: f.tabJumpPrintLineRange = v; break;
      case 20: f.supportsCursorAwareSupercomplete = v; break;
      case 21: f.addCursorToFindReplaceTarget = v; break;
    }
  }
  return f;
}

function decodeInferenceConfig(buf: Buffer): InferenceConfig | undefined {
  // InferenceConfig is a oneof: field 1 = Anthropic, field 2 = Google, field 3 = OpenAi
  for (const sf of iterFields(buf)) {
    if (sf.wire !== 2 || !Buffer.isBuffer(sf.value)) continue;
    if (sf.num === 1) return decodeAnthropicConfig(sf.value as Buffer);
    if (sf.num === 2) return decodeGoogleConfig(sf.value as Buffer);
    if (sf.num === 3) return decodeOpenAiConfig(sf.value as Buffer);
  }
  return undefined;
}

function decodeAnthropicConfig(buf: Buffer): InferenceConfig {
  const cfg: { kind: "anthropic"; effort?: string; thinking?: string; fastMode?: boolean; context1m?: boolean } = { kind: "anthropic" };
  for (const sf of iterFields(buf)) {
    if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) cfg.effort = (sf.value as Buffer).toString("utf8");
    else if (sf.num === 2 && sf.wire === 2 && Buffer.isBuffer(sf.value)) cfg.thinking = (sf.value as Buffer).toString("utf8");
    else if (sf.num === 3 && sf.wire === 0) cfg.fastMode = sf.value === 1n;
    else if (sf.num === 4 && sf.wire === 0) cfg.context1m = sf.value === 1n;
  }
  return cfg;
}

function decodeGoogleConfig(buf: Buffer): InferenceConfig {
  const cfg: { kind: "google"; reasoningEffort?: string; reasoningContext?: string } = { kind: "google" };
  for (const sf of iterFields(buf)) {
    if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) cfg.reasoningEffort = (sf.value as Buffer).toString("utf8");
    else if (sf.num === 2 && sf.wire === 2 && Buffer.isBuffer(sf.value)) cfg.reasoningContext = (sf.value as Buffer).toString("utf8");
  }
  return cfg;
}

function decodeOpenAiConfig(buf: Buffer): InferenceConfig {
  const cfg: { kind: "openai"; extendedPromptCacheRetention?: number; serviceTier?: string } = { kind: "openai" };
  for (const sf of iterFields(buf)) {
    if (sf.num === 1 && sf.wire === 0) cfg.extendedPromptCacheRetention = Number(sf.value);
    else if (sf.num === 2 && sf.wire === 2 && Buffer.isBuffer(sf.value)) cfg.serviceTier = (sf.value as Buffer).toString("utf8");
  }
  return cfg;
}

export class ModelNotAvailableError extends Error {
  constructor(
    public readonly modelUid: string,
    public readonly label: string,
    public readonly reason: "disabled" | "not_listed",
  ) {
    super(
      reason === "disabled"
        ? `Model "${label}" (uid=${modelUid}) is not enabled for your Cognition account. Check https://codeium.com/account.`
        : `Model uid "${modelUid}" is not listed in the Cognition catalog for your account.`,
    );
    this.name = "ModelNotAvailableError";
  }
}
