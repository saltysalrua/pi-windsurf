/**
 * OpenAI-compatible HTTP proxy → Cognition Connect-RPC.
 *
 * Binds at 127.0.0.1:42100 (or fallback port). Accepts standard
 * /v1/chat/completions and /v1/models requests, translates to
 * WindSurf's cloud-direct GetChatMessage wire format.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createServer, type IncomingMessage, type ServerResponse } from "http";

/** L4: backpressure-safe SSE writer. Waits for 'drain' when res.write returns false.
 *  Timeout-protected: if drain doesn't fire within 5s (disconnected client),
 *  the write is abandoned to prevent indefinite hangs. */
async function writeSSE(res: ServerResponse, chunk: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  let ok: boolean;
  try {
    ok = res.write(chunk);
  } catch {
    return; // socket destroyed between check and write
  }
  if (!ok) {
    await new Promise<void>(r => {
      const timer = setTimeout(() => { res.removeListener("drain", onDrain); r(); }, 5000);
      const onDrain = () => { clearTimeout(timer); r(); };
      res.once("drain", onDrain);
    });
  }
}
import { streamChatEvents, CloudChatError, truncateHeadTail, type ChatHistoryItem, type ToolDef, type ResponseMeta } from "./chat";
import { resolveModelOrPassthrough, resolveModelName, getDefaultModel, getCanonicalModels } from "./models";
import { loadCredentials } from "./oauth";
import { getCachedCatalog, type InferenceConfig } from "./catalog";

// L4 output thresholds: sized so 100% of real worker outputs fit without compaction.
// Pi-crew measured 27 real outputs: max 9226 bytes, median 8272, 100% < 16KB.
// Non-streaming responses above this get head+tail compaction (not head-only).
const L4_MAX_RESPONSE_CHARS = 65_536; // 64KB — well above any measured real output
const L4_TRUNC_MARKER = "\n…(output truncated, head+tail preserved)…\n";

const WINDSURF_PROXY_HOST = "127.0.0.1";
const WINDSURF_PROXY_PORT = 42100;

const PORT_FILE = path.join(os.homedir(), ".config", "opencode-windsurf-auth", "proxy-port");

// Per-process secret — same-process callers use this as Bearer token.
export const PROXY_SECRET: string = crypto.randomBytes(32).toString("hex");

/** Detect if this process is a pi-crew child worker. */
function isChildWorker(): boolean {
  return process.env.PI_CREW_KIND === "subagent" || process.env.PI_TEAMS_WORKER === "1";
}

/** Read the parent's proxy port from the well-known file. */
function readParentProxyPort(): number | undefined {
  try {
    const raw = fs.readFileSync(PORT_FILE, "utf8").trim();
    const port = parseInt(raw, 10);
    if (port > 0 && port < 65536) return port;
  } catch {}
  return undefined;
}

/** Write the proxy port to the well-known file so child workers can discover it. */
function writeProxyPort(port: number): void {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PORT_FILE, String(port), { mode: 0o600 });
  } catch {}
}

// In-memory credentials cache — set from extension on startup/after login
export let proxyCredentials: { apiKey: string; apiServerUrl: string } | null = null;
export function setProxyCredentials(creds: { apiKey: string; apiServerUrl: string } | null): void {
  proxyCredentials = creds;
}

// ----------------------------------------------------------------------------
// Proxy handler (Node http server)
// ----------------------------------------------------------------------------

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
  providerOptions?: Record<string, unknown>;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
}

interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
}

function mapMessageToHistoryItem(m: ChatCompletionRequest["messages"][number]): ChatHistoryItem {
  const item: ChatHistoryItem = { role: m.role as ChatHistoryItem["role"], content: m.content as ChatHistoryItem["content"] };
  if (m.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id.length > 0) {
    item.tool_call_id = m.tool_call_id;
  }
  if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    item.tool_calls = m.tool_calls
      .map(tc => ({ id: typeof tc.id === "string" ? tc.id : "", name: typeof tc.function?.name === "string" ? tc.function.name : "", arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : "" }))
      .filter(tc => tc.id !== "" && tc.name !== "");
  }
  return item;
}

function extractVariantFromProviderOptions(providerOptions: Record<string, unknown> | undefined): string | undefined {
  if (!providerOptions) return undefined;
  const windsurfRaw = providerOptions["windsurf"];
  const windsurf = windsurfRaw && typeof windsurfRaw === "object" ? (windsurfRaw as Record<string, unknown>) : undefined;
  const pickString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return pickString(windsurf?.["variant"]) ?? pickString(windsurf?.["variantID"]) ?? pickString(windsurf?.["variantId"]) ?? pickString(providerOptions["variant"]) ?? pickString(providerOptions["variantID"]) ?? pickString(providerOptions["variantId"]);
}

/** Look up catalog entry for a model UID to get isModelRouter + inferenceConfig. */
async function lookupCatalogMeta(apiKey: string, apiServerUrl: string, modelUid: string): Promise<{ isModelRouter?: boolean; inferenceConfig?: InferenceConfig }> {
  try {
    const catalog = await getCachedCatalog(apiKey, apiServerUrl);
    if (catalog) {
      const entry = catalog.byUid.get(modelUid);
      if (entry) return { isModelRouter: entry.isModelRouter, inferenceConfig: entry.inferenceConfig };
    }
  } catch {}
  return {};
}

/** Serialize ResponseMeta into a JSON-safe object for the proxy response. */
export function serializeResponseMeta(meta: ResponseMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (meta.outputId !== undefined) out["output_id"] = meta.outputId;
  if (meta.requestId !== undefined) out["request_id"] = meta.requestId;
  if (meta.timestamp) out["timestamp"] = meta.timestamp;
  if (meta.phase !== undefined) out["phase"] = meta.phase;
  if (meta.actualModelUid !== undefined) out["actual_model_uid"] = meta.actualModelUid;
  if (meta.messageId !== undefined) out["message_id"] = meta.messageId;
  if (meta.inputTokens !== undefined) out["input_tokens"] = meta.inputTokens;
  if (meta.outputTokens !== undefined) out["output_tokens"] = meta.outputTokens;
  if (meta.rawUnknown.size > 0) {
    const raw: Record<string, unknown> = {};
    for (const [num, val] of meta.rawUnknown) {
      const key = `field_${num}`;
      if (val.str !== undefined) raw[key] = val.str;
      else if (val.num !== undefined) raw[key] = val.num;
      else if (val.bool !== undefined) raw[key] = val.bool;
      else if (val.buf) raw[key] = `<${val.buf.length} bytes>`;
    }
    out["_raw_unknown"] = raw;
  }
  return out;
}

function openAIError(status: number, message: string, details?: string): object {
  return { status, body: JSON.stringify({ error: { message: details ? `${message}\n${details}` : message, type: "windsurf_error", param: null, code: null } }), contentType: "application/json" };
}

async function authorizeRequest(req: IncomingMessage): Promise<{ status: number; body: string; contentType: string } | null> {
  const authHeader = (req.headers.authorization ?? "") as string;
  if (!authHeader.startsWith("Bearer ")) {
    return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized: missing or malformed Authorization header.", type: "windsurf_error" } }), contentType: "application/json" };
  }
  const presented = authHeader.slice("Bearer ".length);
  const presentedBuf = Buffer.from(presented, "utf8");

  // Accept per-process secret
  const secretBuf = Buffer.from(PROXY_SECRET, "utf8");
  if (presentedBuf.length === secretBuf.length && crypto.timingSafeEqual(presentedBuf, secretBuf)) return null;

  // Accept in-memory credentials (synced from Pi's OAuth store)
  if (proxyCredentials?.apiKey) {
    const credBuf = Buffer.from(proxyCredentials.apiKey, "utf8");
    if (presentedBuf.length === credBuf.length && crypto.timingSafeEqual(presentedBuf, credBuf)) return null;
  }
  // Accept persisted apiKey from disk (set by standalone CLI)
  try {
    const creds = loadCredentials();
    if (creds?.apiKey && creds.apiKey !== proxyCredentials?.apiKey) {
      const credBuf = Buffer.from(creds.apiKey, "utf8");
      if (presentedBuf.length === credBuf.length && crypto.timingSafeEqual(presentedBuf, credBuf)) return null;
    }
  } catch {}

  return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized: Invalid Bearer token.", type: "windsurf_error" } }), contentType: "application/json" };
}

function getBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${WINDSURF_PROXY_HOST}`);

    // /health — unauthenticated
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Auth gate for everything else
    const authErr = await authorizeRequest(req);
    if (authErr) {
      res.writeHead(authErr.status, { "Content-Type": authErr.contentType });
      res.end(authErr.body);
      return;
    }

    // /v1/models
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      const modelIds = getCanonicalModels();
      const data = modelIds.map(id => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "windsurf" }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }

    // /v1/chat/completions
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Method not allowed; use POST.", type: "windsurf_error" } }));
        return;
      }

      const rawBody = await getBody(req);
      let requestBody: ChatCompletionRequest;
      try { requestBody = JSON.parse(rawBody); }
      catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Malformed JSON." } })); return; }

      if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "messages must be an array." } }));
        return;
      }

      const diskCreds = loadCredentials();
      const creds = diskCreds ?? proxyCredentials;
      if (!creds) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not authenticated. Run /login windsurf first." } }));
        return;
      }

      const requestedModel = requestBody.model || getDefaultModel();
      const variantOverride = extractVariantFromProviderOptions(requestBody.providerOptions);
      const resolved = await resolveModelName(requestedModel, creds.apiKey, creds.apiServerUrl, variantOverride);

      const tools: ToolDef[] = (requestBody.tools ?? []).map(t => ({
        name: t.function?.name ?? "unknown",
        description: t.function?.description ?? "",
        parameters: t.function?.parameters ?? {},
      }));

      const multimodalMessages: ChatHistoryItem[] = requestBody.messages.map(m => mapMessageToHistoryItem(m));

      // Parallel: catalogMeta and catalogEntry are independent lookups
      const [catalogMeta, catalogEntry] = await Promise.all([
        lookupCatalogMeta(creds.apiKey, creds.apiServerUrl, resolved.modelUid),
        getCachedCatalog(creds.apiKey, creds.apiServerUrl),
      ]);
      const modelCatalogEntry = catalogEntry?.byUid.get(resolved.modelUid);
      const catalogMaxTokens = modelCatalogEntry?.maxOutputTokens && modelCatalogEntry.maxOutputTokens > 0 ? modelCatalogEntry.maxOutputTokens : 128_000;
      const requestedMaxTokens = typeof requestBody.max_tokens === "number" && requestBody.max_tokens > 0
        ? (modelCatalogEntry?.maxOutputTokens && modelCatalogEntry.maxOutputTokens > 0
          ? Math.min(requestBody.max_tokens, catalogMaxTokens)
          : requestBody.max_tokens)
        : catalogMaxTokens;
      const isStreaming = requestBody.stream !== false;
      const modelSupportsImages = modelCatalogEntry?.features?.supportsImageCaptions !== false;
      if (!modelSupportsImages) {
        for (const m of multimodalMessages) {
          if (Array.isArray(m.content)) {
            m.content = m.content.filter(p => p.type !== "image");
          }
        }
      }

      if (isStreaming) {
        // SSE streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const responseId = `chatcmpl-${crypto.randomUUID()}`;
        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });

        try {
          let firstChunkSent = false;
          let toolCallIndex = -1;
          const toolIdToIndex = new Map<string, number>();
          let lastToolCallId: string | undefined;
          let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | null = null;
          let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedInputTokens?: number; cacheCreationInputTokens?: number } | null = null;
          let responseMeta: ResponseMeta | null = null;

          for await (const ev of streamChatEvents({
            apiKey: creds.apiKey,
            apiServerUrl: creds.apiServerUrl,
            modelUid: resolved.modelUid,
            isModelRouter: catalogMeta.isModelRouter,
            inferenceConfig: catalogMeta.inferenceConfig,
            messages: multimodalMessages,
            tools: tools.length > 0 ? tools : undefined,
            signal: abort.signal,
            completionOpts: { maxOutputTokens: requestedMaxTokens },
          })) {
            const role = firstChunkSent ? undefined : "assistant";

            if (ev.kind === "text") {
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: role ? { role, content: ev.text } : { content: ev.text }, finish_reason: null }] };
              await writeSSE(res, `data: ${JSON.stringify(chunk)}\n\n`);
              firstChunkSent = true;
            } else if (ev.kind === "reasoning") {
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: role ? { role, reasoning: ev.text } : { reasoning: ev.text }, finish_reason: null }] };
              await writeSSE(res, `data: ${JSON.stringify(chunk)}\n\n`);
              firstChunkSent = true;
            } else if (ev.kind === "tool_call_start") {
              toolCallIndex += 1;
              toolIdToIndex.set(ev.id, toolCallIndex);
              lastToolCallId = ev.id;
              const baseDelta = { tool_calls: [{ index: toolCallIndex, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] };
              const delta = firstChunkSent ? baseDelta : { role: "assistant", ...baseDelta };
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta, finish_reason: null }] };
              await writeSSE(res, `data: ${JSON.stringify(chunk)}\n\n`);
              firstChunkSent = true;
            } else if (ev.kind === "tool_call_args") {
              if (lastToolCallId === undefined || toolCallIndex < 0) continue;
              const routeKey = ev.id ?? lastToolCallId;
              const idx = toolIdToIndex.get(routeKey) ?? toolCallIndex;
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: ev.argsDelta } }] }, finish_reason: null }] };
              await writeSSE(res, `data: ${JSON.stringify(chunk)}\n\n`);
            } else if (ev.kind === "finish") {
              finishReason = ev.reason;
            } else if (ev.kind === "usage") {
              usage = {
                promptTokens: ev.promptTokens,
                completionTokens: ev.completionTokens,
                totalTokens: ev.totalTokens,
                cachedInputTokens: ev.cachedInputTokens,
                cacheCreationInputTokens: ev.cacheCreationInputTokens,
              };
            } else if (ev.kind === "meta") {
              responseMeta = ev.fields;
            }
          }

          // Store metadata in side channel for extension lookup via message_end
          if (responseMeta) storeResponseMeta(responseId, responseMeta);

          const finalReason = finishReason ?? (toolCallIndex >= 0 ? "tool_calls" : "stop");
          const finishChunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: finalReason }] };
          await writeSSE(res, `data: ${JSON.stringify(finishChunk)}\n\n`);

          if (usage) {
            const usageData: Record<string, unknown> = {
              prompt_tokens: usage.promptTokens ?? 0,
              completion_tokens: usage.completionTokens ?? 0,
              total_tokens: usage.totalTokens ?? 0,
            };
            if (usage.cachedInputTokens !== undefined) {
              usageData.cache_read_input_tokens = usage.cachedInputTokens;
              usageData.prompt_tokens_details = { cached_tokens: usage.cachedInputTokens };
            }
            if (usage.cacheCreationInputTokens !== undefined) usageData.cache_creation_input_tokens = usage.cacheCreationInputTokens;
            const usageChunk: Record<string, unknown> = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [], usage: usageData };
            if (responseMeta) usageChunk["_windsurf_meta"] = serializeResponseMeta(responseMeta);
            await writeSSE(res, `data: ${JSON.stringify(usageChunk)}\n\n`);
          }
          await writeSSE(res, "data: [DONE]\n\n");
          res.end();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          try {
            await writeSSE(res, `data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`);
            const fChunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            await writeSSE(res, `data: ${JSON.stringify(fChunk)}\n\n`);
            await writeSSE(res, "data: [DONE]\n\n");
            res.end();
          } catch { /* socket dead */ }
        }
      } else {
        // Non-streaming response
        let collected = "";
        let finishReason: "stop" | "tool_calls" | "length" | "content_filter" = "stop";
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedInputTokens?: number; cacheCreationInputTokens?: number } | null = null;
        let responseMeta: ResponseMeta | null = null;
        type CollectedToolCall = { id: string; name: string; args: string };
        const collectedToolCalls: CollectedToolCall[] = [];
        let currentToolCall: CollectedToolCall | null = null;

        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });
        for await (const ev of streamChatEvents({
          apiKey: creds.apiKey,
          apiServerUrl: creds.apiServerUrl,
          modelUid: resolved.modelUid,
          isModelRouter: catalogMeta.isModelRouter,
          inferenceConfig: catalogMeta.inferenceConfig,
          messages: multimodalMessages,
          tools: tools.length > 0 ? tools : undefined,
          completionOpts: { maxOutputTokens: requestedMaxTokens },
          signal: abort.signal,
        })) {
          if (ev.kind === "text") collected += ev.text;
          else if (ev.kind === "tool_call_start") { currentToolCall = { id: ev.id, name: ev.name, args: "" }; collectedToolCalls.push(currentToolCall); }
          else if (ev.kind === "tool_call_args") { if (currentToolCall) currentToolCall.args += ev.argsDelta; }
          else if (ev.kind === "finish") finishReason = ev.reason;
          else if (ev.kind === "usage") {
            usage = {
              promptTokens: ev.promptTokens,
              completionTokens: ev.completionTokens,
              totalTokens: ev.totalTokens,
              cachedInputTokens: ev.cachedInputTokens,
              cacheCreationInputTokens: ev.cacheCreationInputTokens,
            };
          }
          else if (ev.kind === "meta") responseMeta = ev.fields;
        }
        if (collectedToolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";

        // L4: apply head+tail compaction when response exceeds threshold.
        // 100% of real outputs fit unchanged; only oversized responses compact.
        if (collected.length > L4_MAX_RESPONSE_CHARS) {
          collected = truncateHeadTail(collected, L4_MAX_RESPONSE_CHARS, L4_TRUNC_MARKER);
        }

        const assistantMessage = collectedToolCalls.length > 0
          ? { role: "assistant" as const, content: collected, tool_calls: collectedToolCalls.map(tc => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })) }
          : { role: "assistant" as const, content: collected };

        const responseId = `chatcmpl-${crypto.randomUUID()}`;
        // Store metadata in side channel for extension lookup via message_end
        if (responseMeta) storeResponseMeta(responseId, responseMeta);

        const openAIUsage: Record<string, unknown> = {
          prompt_tokens: usage?.promptTokens ?? 0,
          completion_tokens: usage?.completionTokens ?? 0,
          total_tokens: usage?.totalTokens ?? 0,
        };
        if (usage?.cachedInputTokens !== undefined) {
          openAIUsage.cache_read_input_tokens = usage.cachedInputTokens;
          openAIUsage.prompt_tokens_details = { cached_tokens: usage.cachedInputTokens };
        }
        if (usage?.cacheCreationInputTokens !== undefined) openAIUsage.cache_creation_input_tokens = usage.cacheCreationInputTokens;

        const resp: Record<string, unknown> = {
          id: responseId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{ index: 0, message: assistantMessage, finish_reason: finishReason }],
          ...(usage ? { usage: openAIUsage } : {}),
        };
        if (responseMeta) resp["_windsurf_meta"] = serializeResponseMeta(responseMeta);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      }
      return;
    }

    // /v1/messages — Anthropic Messages API
    if (url.pathname === "/v1/messages" || url.pathname === "/messages") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Method not allowed; use POST." } }));
        return;
      }

      const rawBody = await getBody(req);
      let anthroBody: AnthropicRequest;
      try { anthroBody = JSON.parse(rawBody); }
      catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Malformed JSON." } })); return; }

      if (!anthroBody.messages || !Array.isArray(anthroBody.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages must be an array." } }));
        return;
      }

      const diskCreds = loadCredentials();
      const creds = diskCreds ?? proxyCredentials;
      if (!creds) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Not authenticated. Run /login windsurf first." } }));
        return;
      }

      const requestedModel = anthroBody.model || getDefaultModel();
      const resolved = await resolveModelName(requestedModel, creds.apiKey, creds.apiServerUrl);
      const [catalogMeta, catalog] = await Promise.all([
        lookupCatalogMeta(creds.apiKey, creds.apiServerUrl, resolved.modelUid),
        getCachedCatalog(creds.apiKey, creds.apiServerUrl),
      ]);
      const catalogEntry = catalog?.byUid.get(resolved.modelUid);
      const catalogMaxTokens = catalogEntry?.maxOutputTokens && catalogEntry.maxOutputTokens > 0 ? catalogEntry.maxOutputTokens : 128_000;

      // Convert Anthropic messages to ChatHistoryItem[]
      const multimodalMessages: ChatHistoryItem[] = [];
      if (anthroBody.system) {
        const sysText = typeof anthroBody.system === "string" ? anthroBody.system : anthroBody.system.map(p => p.text).join("\n");
        multimodalMessages.push({ role: "system", content: sysText });
      }
      for (const m of anthroBody.messages) {
        if (typeof m.content === "string") {
          multimodalMessages.push({ role: m.role as ChatHistoryItem["role"], content: m.content });
        } else if (Array.isArray(m.content)) {
          const parts: ChatHistoryItem["content"] = [];
          for (const p of m.content) {
            if (p.type === "text") parts.push({ type: "text", text: p.text ?? "" });
            else if (p.type === "image" && p.source?.type === "base64") {
              parts.push({ type: "image", mimeType: p.source.media_type, base64Data: p.source.data });
            }
          }
          multimodalMessages.push({ role: m.role as ChatHistoryItem["role"], content: parts });
        }
      }

      const tools: ToolDef[] = (anthroBody.tools ?? []).map(t => ({
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? {},
      }));

      const requestedMaxTokens = typeof anthroBody.max_tokens === "number" && anthroBody.max_tokens > 0 ? anthroBody.max_tokens : catalogMaxTokens;
      const isStreaming = anthroBody.stream !== false;
      const msgId = `msg_${crypto.randomBytes(12).toString("hex")}`;

      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });

        try {
          let blockIndex = 0;
          let blockOpen = false;
          let finishReason: string | null = null;
          let inputTokens = 0;
          let outputTokens = 0;
          let cachedInputTokens: number | undefined;
          let cacheCreationInputTokens: number | undefined;

          const writeSse = async (event: string, data: object): Promise<void> => writeSSE(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          const openTextBlock = async () => { await writeSse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }); blockOpen = true; };
          const closeBlock = async () => { await writeSse("content_block_stop", { type: "content_block_stop", index: blockIndex }); blockOpen = false; blockIndex++; };

          await writeSse("message_start", {
            type: "message_start",
            message: { id: msgId, type: "message", role: "assistant", content: [], model: requestedModel, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
          });

          for await (const ev of streamChatEvents({
            apiKey: creds.apiKey,
            apiServerUrl: creds.apiServerUrl,
            modelUid: resolved.modelUid,
            isModelRouter: catalogMeta.isModelRouter,
            inferenceConfig: catalogMeta.inferenceConfig,
            messages: multimodalMessages,
            tools: tools.length > 0 ? tools : undefined,
            signal: abort.signal,
            completionOpts: { maxOutputTokens: requestedMaxTokens },
          })) {
            if (ev.kind === "text") {
              if (!blockOpen) await openTextBlock();
              await writeSse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: ev.text } });
            } else if (ev.kind === "reasoning") {
              if (!blockOpen) await openTextBlock();
              await writeSse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: ev.text } });
            } else if (ev.kind === "tool_call_start") {
              if (blockOpen) await closeBlock();
              await writeSse("content_block_start", {
                type: "content_block_start", index: blockIndex,
                content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} },
              });
              blockOpen = true;
            } else if (ev.kind === "tool_call_args") {
              if (ev.argsDelta) {
                await writeSse("content_block_delta", {
                  type: "content_block_delta", index: blockIndex,
                  delta: { type: "input_json_delta", partial_json: ev.argsDelta },
                });
              }
            } else if (ev.kind === "finish") {
              finishReason = ev.reason;
            } else if (ev.kind === "usage") {
              inputTokens = ev.promptTokens ?? 0;
              outputTokens = ev.completionTokens ?? 0;
              cachedInputTokens = ev.cachedInputTokens;
              cacheCreationInputTokens = ev.cacheCreationInputTokens;
            }
          }

          if (blockOpen) await closeBlock();

          const stopReason = finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn";
          const anthropicUsage: Record<string, unknown> = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          };
          if (cachedInputTokens !== undefined) anthropicUsage.cache_read_input_tokens = cachedInputTokens;
          if (cacheCreationInputTokens !== undefined) anthropicUsage.cache_creation_input_tokens = cacheCreationInputTokens;
          await writeSse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: anthropicUsage,
          });
          await writeSse("message_stop", { type: "message_stop" });
          res.end();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          try {
            await writeSSE(res, `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage } })}\n\n`);
            res.end();
          } catch (writeErr) { /* client disconnected */ }
        }
      } else {
        // Non-streaming
        let collected = "";
        let finishReason: string | null = null;
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedInputTokens: number | undefined;
        let cacheCreationInputTokens: number | undefined;
        const collectedToolCalls: Array<{ id: string; name: string; args: string }> = [];
        let currentToolCall: { id: string; name: string; args: string } | null = null;

        const abort = new AbortController();
        for await (const ev of streamChatEvents({
          apiKey: creds.apiKey,
          apiServerUrl: creds.apiServerUrl,
          modelUid: resolved.modelUid,
          isModelRouter: catalogMeta.isModelRouter,
          inferenceConfig: catalogMeta.inferenceConfig,
          messages: multimodalMessages,
          tools: tools.length > 0 ? tools : undefined,
          completionOpts: { maxOutputTokens: requestedMaxTokens },
          signal: abort.signal,
        })) {
          if (ev.kind === "text") collected += ev.text;
          else if (ev.kind === "tool_call_start") { currentToolCall = { id: ev.id, name: ev.name, args: "" }; collectedToolCalls.push(currentToolCall); }
          else if (ev.kind === "tool_call_args") { if (currentToolCall) currentToolCall.args += ev.argsDelta; }
          else if (ev.kind === "finish") finishReason = ev.reason;
          else if (ev.kind === "usage") {
            inputTokens = ev.promptTokens ?? 0;
            outputTokens = ev.completionTokens ?? 0;
            cachedInputTokens = ev.cachedInputTokens;
            cacheCreationInputTokens = ev.cacheCreationInputTokens;
          }
        }

        const contentBlocks: Array<Record<string, unknown>> = [];
        // L4: head+tail compaction for oversized non-streaming responses.
        if (collected) {
          if (collected.length > L4_MAX_RESPONSE_CHARS) {
            collected = truncateHeadTail(collected, L4_MAX_RESPONSE_CHARS, L4_TRUNC_MARKER);
          }
          contentBlocks.push({ type: "text", text: collected });
        }
        for (const tc of collectedToolCalls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.args); } catch { input = { raw: tc.args }; }
          contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }

        const anthropicUsage: Record<string, unknown> = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        };
        if (cachedInputTokens !== undefined) anthropicUsage.cache_read_input_tokens = cachedInputTokens;
        if (cacheCreationInputTokens !== undefined) anthropicUsage.cache_creation_input_tokens = cacheCreationInputTokens;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: msgId,
          type: "message",
          role: "assistant",
          content: contentBlocks,
          model: requestedModel,
          stop_reason: collectedToolCalls.length > 0 ? "tool_use" : (finishReason === "length" ? "max_tokens" : "end_turn"),
          usage: anthropicUsage,
        }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unsupported path: ${url.pathname}` } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    } catch {}
  }
}

// ----------------------------------------------------------------------------
// Server startup
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Response metadata side channel
// ----------------------------------------------------------------------------
// Pi's AssistantMessage type doesn't preserve custom fields like _windsurf_meta.
// Store metadata keyed by responseId so the extension can look it up in message_end.
const responseMetaCache = new Map<string, ResponseMeta>();
const META_CACHE_TTL_MS = 5 * 60 * 1000;

export function storeResponseMeta(responseId: string, meta: ResponseMeta): void {
  responseMetaCache.set(responseId, meta);
  setTimeout(() => responseMetaCache.delete(responseId), META_CACHE_TTL_MS);
}

export function getResponseMeta(responseId: string): ResponseMeta | undefined {
  const meta = responseMetaCache.get(responseId);
  if (meta) responseMetaCache.delete(responseId);
  return meta;
}

let serverInstance: ReturnType<typeof createServer> | null = null;

export function startProxy(port: number = WINDSURF_PROXY_PORT): Promise<number> {
  if (serverInstance) return Promise.resolve((serverInstance.address() as { port: number }).port);

  return new Promise((resolve, reject) => {
    const srv = createServer(handleRequest);
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try fallback port
        srv.listen(0, WINDSURF_PROXY_HOST, () => {
          const addr = srv.address() as { port: number };
          serverInstance = srv;
          writeProxyPort(addr.port);
          resolve(addr.port);
        });
        return;
      }
      reject(err);
    });
    srv.listen(port, WINDSURF_PROXY_HOST, () => {
      serverInstance = srv;
      const addr = srv.address() as { port: number };
      writeProxyPort(addr.port);
      resolve(addr.port);
    });
  });
}

/** For child workers: don't start a proxy, connect to the parent's instead. */
export function getChildProxyUrl(): { baseUrl: string; anthropicBaseUrl: string; apiKey: string } | null {
  if (!isChildWorker()) return null;
  const parentPort = readParentProxyPort() ?? WINDSURF_PROXY_PORT;
  const creds = loadCredentials();
  if (!creds) return null;
  return {
    baseUrl: `http://127.0.0.1:${parentPort}/v1`,
    anthropicBaseUrl: `http://127.0.0.1:${parentPort}`,
    apiKey: creds.apiKey,
  };
}

export function stopProxy(): void {
  if (serverInstance) {
    try { serverInstance.close(); } catch {}
    serverInstance = null;
  }
}
