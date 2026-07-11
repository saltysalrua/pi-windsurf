/**
 * Anthropic Messages API compatibility for Windsurf.
 *
 * This module is a focused port of WindsurfAPI's `src/handlers/messages.js`
 * and the accompanying `src/handlers/chat.js` usage normalization. It is used
 * by the local proxy to convert Anthropic SDK requests into the OpenAI-ish
 * requests that `chat.ts` already sends, and to convert the SSE responses back
 * into Anthropic Messages API streaming events.
 */

import type { ServerResponse } from "node:http";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface AnthropicBaseBlock {
  cache_control?: AnthropicCacheControl;
  [key: string]: unknown;
}

export interface AnthropicTextBlock extends AnthropicBaseBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageSourceBase64 {
  type: "base64";
  media_type: string;
  data: string;
}

export interface AnthropicImageSourceUrl {
  type: "url";
  url: string;
}

export interface AnthropicImageBlock extends AnthropicBaseBlock {
  type: "image";
  source: AnthropicImageSourceBase64 | AnthropicImageSourceUrl;
}

export interface AnthropicDocumentBlock extends AnthropicBaseBlock {
  type: "document";
  source: { type: "text"; data: string } | { type: "content"; content: unknown[] } | { type: "base64"; media_type: string } | { type: "url"; url: string };
  title?: string;
}

export interface AnthropicToolUseBlock extends AnthropicBaseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock extends AnthropicBaseBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
}

export interface AnthropicThinkingBlock extends AnthropicBaseBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool extends AnthropicBaseBlock {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: "web_search_20250305" | "code_execution_20250522" | "advisor_20260301" | "function";
}

export interface AnthropicToolChoice {
  type: "auto" | "any" | "none" | "tool";
  name?: string;
  disable_parallel_tool_use?: boolean;
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | { type: "text"; text: string; cache_control?: AnthropicCacheControl }[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: "enabled" | "adaptive" | "disabled"; budget_tokens?: number };
  output_config?: { effort?: string; format?: { type: "json_schema" | "json_object"; schema?: Record<string, unknown>; name?: string; strict?: boolean } };
  metadata?: { user_id?: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface OpenAIRequest {
  model?: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  response_format?: { type: "json_schema" | "json_object"; json_schema?: { name: string; schema: Record<string, unknown>; strict: boolean } } | null;
  thinking?: { type: "enabled" | "adaptive" | "disabled"; budget_tokens?: number };
  __cachePolicy?: AnthropicCachePolicy;
}

export interface AnthropicCachePolicy {
  has1h: boolean;
  breakpointCount: number;
  estCacheCreationTokens: number;
  est5mTokens: number;
  est1hTokens: number;
  minCacheablePrefix: number;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  server_tool_use?: { web_search_requests?: number };
  service_tier?: string;
}

// ----------------------------------------------------------------------------
// Error mapping
// ----------------------------------------------------------------------------

const STOP_REASON_MAP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
};

function mapStopReason(finishReason: string | null | undefined): string {
  return STOP_REASON_MAP[finishReason || ""] || "end_turn";
}

function resolveStopSequence(finishReason: string | null | undefined, text: string, stopSequences?: string[]): { stopReason: string; stopSequence: string | null } {
  const base = mapStopReason(finishReason);
  if (base !== "end_turn" || !Array.isArray(stopSequences) || stopSequences.length === 0) return { stopReason: base, stopSequence: null };
  if (!text) return { stopReason: base, stopSequence: null };
  for (const seq of stopSequences) {
    if (typeof seq === "string" && seq && text.endsWith(seq)) return { stopReason: "stop_sequence", stopSequence: seq };
  }
  return { stopReason: base, stopSequence: null };
}

const INTERNAL_LEAK_MARKERS = [
  "devin_connect",
  "dead session token",
  "session token",
  "accounts exhausted",
  "pooled account",
  "failover",
  "cascade",
];

function clientFacingMessage(type: string, rawMessage: string): string {
  const generic: Record<string, string> = {
    invalid_request_error: "Invalid request",
    authentication_error: "Authentication failed",
    permission_error: "You do not have permission to access this resource",
    not_found_error: "Not found",
    request_too_large: "Request body too large",
    rate_limit_error: "Rate limit exceeded, please retry later",
    api_error: "Internal server error",
    overloaded_error: "The service is temporarily overloaded, please retry",
  };
  const fallback = generic[type] || "Upstream error";
  if (!rawMessage) return fallback;
  const lower = rawMessage.toLowerCase();
  if (INTERNAL_LEAK_MARKERS.some((m) => lower.includes(m))) return fallback;
  return rawMessage;
}

export function toAnthropicError(
  status: number,
  internalType: string | undefined,
  message: string,
): { status: number; body: { type: string; error: { type: string; message: string } } } {
  let outStatus = status;
  let type: string | null = null;
  switch (internalType) {
    case "capacity_error": type = "overloaded_error"; outStatus = 529; break;
    case "insufficient_quota": type = "rate_limit_error"; outStatus = 429; break;
    case "model_blocked": type = "permission_error"; outStatus = 403; break;
    case "upstream_transient_error":
    case "upstream_internal_error":
    case "timeout_error": type = "overloaded_error"; outStatus = 529; break;
    case "rate_limit_error":
    case "rate_limit_exceeded": type = "rate_limit_error"; outStatus = 429; break;
    default: break;
  }
  if (!type) {
    switch (status) {
      case 400: type = "invalid_request_error"; break;
      case 401: type = "authentication_error"; break;
      case 403: type = "permission_error"; break;
      case 404: type = "not_found_error"; break;
      case 402: type = "rate_limit_error"; outStatus = 429; break;
      case 413: type = "request_too_large"; break;
      case 429: type = "rate_limit_error"; break;
      case 504: type = "overloaded_error"; outStatus = 529; break;
      case 529: type = "overloaded_error"; break;
      case 502:
      case 503: type = "overloaded_error"; outStatus = 529; break;
      default: type = status >= 500 ? "api_error" : "invalid_request_error";
    }
  }
  return {
    status: outStatus,
    body: { type: "error", error: { type: type as string, message: clientFacingMessage(type as string, message) } },
  };
}

// ----------------------------------------------------------------------------
// Request validation
// ----------------------------------------------------------------------------

const VALID_CACHE_TTLS = new Set(["5m", "1h"]);

function invalidRequest(message: string): { status: number; body: { type: string; error: { type: string; message: string } } } {
  return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message } } };
}

function validateCacheControl(cc: unknown, where: string): { status: number; body: { type: string; error: { type: string; message: string } } } | null {
  if (cc === null || cc === undefined) return null;
  if (typeof cc !== "object") return invalidRequest(`cache_control on ${where} must be an object`);
  const c = cc as { type?: string; ttl?: string };
  if (c.type !== "ephemeral") return invalidRequest(`cache_control.type on ${where} must be 'ephemeral'`);
  if (c.ttl !== null && c.ttl !== undefined && !VALID_CACHE_TTLS.has(c.ttl)) return invalidRequest(`cache_control.ttl on ${where} must be one of: 5m, 1h`);
  return null;
}

export function validateMessagesRequest(body: unknown): { status: number; body: { type: string; error: { type: string; message: string } } } | null {
  if (!body || typeof body !== "object") return invalidRequest("request body must be a JSON object");
  const b = body as AnthropicRequest;
  if (b.model === null || b.model === undefined || b.model === "") return invalidRequest("model: field required");
  if (b.max_tokens === null || b.max_tokens === undefined) return invalidRequest("max_tokens: field required");
  if (typeof b.max_tokens !== "number" || !Number.isInteger(b.max_tokens) || b.max_tokens < 1) return invalidRequest("max_tokens must be a positive integer");
  let breakpointCount = 0;
  const scan = (block: unknown, where: string): { status: number; body: { type: string; error: { type: string; message: string } } } | null => {
    if (!block || typeof block !== "object") return null;
    const cc = (block as { cache_control?: unknown }).cache_control;
    if (cc === null || cc === undefined) return null;
    const err = validateCacheControl(cc, where);
    if (err) return err;
    breakpointCount++;
    return null;
  };
  if (Array.isArray(b.tools)) {
    for (let i = 0; i < b.tools.length; i++) {
      const err = scan(b.tools[i], `tools[${i}]`);
      if (err) return err;
    }
  }
  if (Array.isArray(b.system)) {
    for (let i = 0; i < b.system.length; i++) {
      const err = scan(b.system[i], `system[${i}]`);
      if (err) return err;
    }
  }
  if (Array.isArray(b.messages)) {
    for (let mi = 0; mi < b.messages.length; mi++) {
      const content = b.messages[mi].content;
      if (!Array.isArray(content)) continue;
      for (let ci = 0; ci < content.length; ci++) {
        const err = scan(content[ci], `messages[${mi}].content[${ci}]`);
        if (err) return err;
      }
    }
  }
  if (breakpointCount > 4) return invalidRequest(`a maximum of 4 cache_control blocks is allowed, got ${breakpointCount}`);
  return null;
}

// ----------------------------------------------------------------------------
// Cache policy (extractCachePolicy)
// ----------------------------------------------------------------------------

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

function anthropicBlockTokens(block: AnthropicContentBlock): number {
  if (!block || typeof block !== "object") return 0;
  if (block.type === "text") return estimateTextTokens(block.text || "");
  if (block.type === "image") {
    const src = block.source;
    if (src.type === "base64") return Math.max(1, Math.floor(src.data.length * 3 / 4 / 4));
    return 0;
  }
  if (block.type === "document") {
    const src = block.source;
    if (src.type === "text") return estimateTextTokens(src.data || "");
    if (src.type === "content" && Array.isArray(src.content)) return estimateTextTokens(JSON.stringify(src.content));
    return 0;
  }
  if (block.type === "tool_use") return estimateTextTokens(block.name || "") + estimateTextTokens(JSON.stringify(block.input || {}));
  if (block.type === "tool_result") return estimateTextTokens(typeof block.content === "string" ? block.content : JSON.stringify(block.content || {}));
  return 0;
}

function cacheToolTokens(t: AnthropicTool): number {
  if (!t || typeof t !== "object") return 0;
  let n = estimateTextTokens(t.name || "") + estimateTextTokens(t.description || "");
  if (t.input_schema) n += estimateTextTokens(JSON.stringify(t.input_schema));
  return n;
}

const MIN_CACHEABLE_PREFIX_DEFAULT = 1024;
const MIN_CACHEABLE_PREFIX_HAIKU = 2048;

function minCacheablePrefixTokens(model: string | undefined): number {
  return /haiku/i.test(String(model || "")) ? MIN_CACHEABLE_PREFIX_HAIKU : MIN_CACHEABLE_PREFIX_DEFAULT;
}

function deepClone<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export function extractCachePolicy(body: AnthropicRequest): AnthropicCachePolicy {
  let breakpointCount = 0;
  let has1h = false;
  let runningTokens = 0;
  let estCacheCreationTokens = 0;
  let est5mTokens = 0;
  let est1hTokens = 0;
  let lastBreakpointTokens = 0;
  const clone = deepClone(body);
  const visit = (block: Record<string, unknown> & { cache_control?: unknown }, tokens: number): void => {
    if (!block || typeof block !== "object") return;
    runningTokens += tokens;
    const cc = block.cache_control as { type?: string; ttl?: "5m" | "1h" } | undefined;
    if (cc && typeof cc === "object" && cc.type === "ephemeral") {
      breakpointCount++;
      const is1h = cc.ttl === "1h";
      if (is1h) has1h = true;
      const increment = Math.max(0, runningTokens - lastBreakpointTokens);
      if (is1h) est1hTokens += increment;
      else est5mTokens += increment;
      lastBreakpointTokens = runningTokens;
      estCacheCreationTokens = runningTokens;
    }
  };
  if (Array.isArray(clone.tools)) {
    for (const t of clone.tools) {
      const tool = t as AnthropicTool;
      visit(tool, cacheToolTokens(tool));
      tool.cache_control = undefined;
    }
  }
  if (typeof clone.system === "string") {
    runningTokens += estimateTextTokens(clone.system);
  } else if (Array.isArray(clone.system)) {
    for (const s of clone.system) {
      const block = s as { type: string; text: string; cache_control?: unknown };
      if (block.type === "text") visit(block, estimateTextTokens(block.text || ""));
      block.cache_control = undefined;
    }
  }
  if (Array.isArray(clone.messages)) {
    for (const m of clone.messages) {
      const message = m as AnthropicMessage;
      if (Array.isArray(message.content)) {
        for (const c of message.content) {
          const block = c as AnthropicContentBlock;
          visit(block as unknown as Record<string, unknown> & { cache_control?: unknown }, anthropicBlockTokens(block));
          block.cache_control = undefined;
        }
      } else if (typeof message.content === "string") {
        runningTokens += estimateTextTokens(message.content);
      }
    }
  }
  return {
    has1h,
    breakpointCount,
    estCacheCreationTokens,
    est5mTokens,
    est1hTokens,
    minCacheablePrefix: minCacheablePrefixTokens(body.model),
  };
}

// ----------------------------------------------------------------------------
// Anthropic → OpenAI translation
// ----------------------------------------------------------------------------

function normalizeImageBlock(block: AnthropicImageBlock): { type: "image_url"; image_url: { url: string } } | null {
  const src = block.source;
  if (src.type === "base64") {
    const mt = src.media_type || "image/png";
    return { type: "image_url", image_url: { url: `data:${mt};base64,${src.data}` } };
  }
  if (src.type === "url") {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return null;
}

function flattenContentBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") { parts.push(String(b ?? "")); continue; }
    const block = b as { type?: string; text?: string; source?: { media_type?: string } };
    if (block.type === "image") {
      const mt = block.source?.media_type || "image";
      parts.push(`[image: ${mt}]`);
    } else if (typeof block.text === "string") {
      parts.push(block.text);
    } else {
      parts.push("");
    }
  }
  return parts.join("\n");
}

// Server-side Anthropic tool types that the proxy cannot satisfy.
const SERVER_SIDE_ANTHROPIC_TOOL_TYPES = new Set(["code_execution_20250522", "advisor_20260301"]);

function convertServerSideTool(t: AnthropicTool): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } | null {
  if (t?.type === "web_search_20250305") {
    return {
      type: "function",
      function: { name: "web_search", description: t.description || "Search the web", parameters: t.input_schema || { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    };
  }
  return null;
}

// Minimal neutralization of competitor self-identification and security policy.
function neutralizeClientIdentity(text: string): string {
  return text
    .replace(/Claude Code, Anthropic's official CLI for Claude/gi, "an AI coding assistant")
    .replace(/authorized security testing|CTF|DoS attacks|C2 frameworks|exploit development/gi, "security research under responsible disclosure");
}

function mapAnthropicToolChoice(toolChoice: AnthropicToolChoice | undefined): "auto" | "required" | "none" | { type: "function"; function: { name: string } } | undefined {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && toolChoice.name) return { type: "function", function: { name: toolChoice.name } };
  return undefined;
}

function pruneToolChoice(
  toolChoice: OpenAIRequest["tool_choice"],
  forwardedTools: OpenAIRequest["tools"],
): OpenAIRequest["tool_choice"] {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const names = new Set(forwardedTools?.map((t) => t.function.name).filter(Boolean) || []);
    return names.has(toolChoice.function.name) ? toolChoice : undefined;
  }
  return toolChoice;
}

export function anthropicToOpenAI(body: AnthropicRequest): { openAI: OpenAIRequest; cachePolicy: AnthropicCachePolicy } {
  const cachePolicy = extractCachePolicy(body);
  const messages: OpenAIMessage[] = [];
  const toolNameById = new Map<string, string>();

  if (body.system) {
    const rawSys = typeof body.system === "string" ? body.system : body.system.map((b) => b.text).join("\n");
    const sysText = neutralizeClientIdentity(rawSys);
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  for (const m of body.messages || []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      messages.push({ role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const textParts: string[] = [];
      const imageParts: OpenAIMessage["content"] = [];
      const toolCalls: OpenAIMessage["tool_calls"] = [];
      const toolResults: OpenAIMessage[] = [];
      for (const block of m.content) {
        if (block.type === "text") {
          textParts.push(block.text || "");
        } else if (block.type === "image") {
          const normalized = normalizeImageBlock(block);
          if (normalized) imageParts.push(normalized);
        } else if (block.type === "document") {
          const src = block.source;
          if (src.type === "text" && typeof src.data === "string") {
            textParts.push(src.data);
          } else if (src.type === "content" && Array.isArray(src.content)) {
            textParts.push(flattenContentBlocks(src.content));
          } else {
            const mt = (src as { media_type?: string }).media_type || (src.type === "base64" ? "application/pdf" : "unknown");
            const label = block.title ? `${block.title} (${mt})` : mt;
            textParts.push(`[document: ${label} — content not extracted]`);
          }
        } else if (block.type === "tool_use" && role === "assistant") {
          const id = block.id || `call_${Math.random().toString(36).slice(2, 10)}`;
          toolNameById.set(id, block.name || "");
          toolCalls.push({ id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
        } else if (block.type === "tool_result") {
          const content = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? flattenContentBlocks(block.content) : JSON.stringify(block.content);
          toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content });
        }
      }
      for (const tr of toolResults) messages.push(tr);
      if (toolCalls.length) {
        messages.push({ role: "assistant", content: textParts.length ? textParts.join("\n") : null, tool_calls: toolCalls });
      } else if (imageParts.length) {
        const contentArr = [...imageParts];
        if (textParts.length) contentArr.push({ type: "text", text: textParts.join("\n") });
        messages.push({ role, content: contentArr });
      } else if (textParts.length) {
        messages.push({ role, content: textParts.join("\n") });
      }
    }
  }

  const droppedServerTools: string[] = [];
  const convertedServerTools: string[] = [];
  const tools: OpenAIRequest["tools"] = [];
  for (const t of body.tools || []) {
    if (t?.type && SERVER_SIDE_ANTHROPIC_TOOL_TYPES.has(t.type)) {
      droppedServerTools.push(t.type);
      continue;
    }
    if (t?.type === "web_search_20250305") {
      const converted = convertServerSideTool(t);
      if (converted) {
        tools.push(converted);
        convertedServerTools.push("web_search_20250305→web_search");
      }
      continue;
    }
    tools.push({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} } });
  }

  const forwardedToolChoice = pruneToolChoice(
    body.tool_choice ? mapAnthropicToolChoice(body.tool_choice) : undefined,
    tools,
  );

  const oc = body.output_config;
  let translatedResponseFormat: OpenAIRequest["response_format"] = null;
  if (oc?.format?.type === "json_schema" && oc.format.schema) {
    translatedResponseFormat = { type: "json_schema", json_schema: { name: oc.format.name || "response", schema: oc.format.schema, strict: oc.format.strict !== false } };
  } else if (oc?.format?.type === "json_object") {
    translatedResponseFormat = { type: "json_object" };
  }

  const openAI: OpenAIRequest = {
    model: body.model || "claude-sonnet-4.6",
    messages,
    max_tokens: body.max_tokens || 8192,
    stream: body.stream !== false,
    ...(tools.length ? { tools } : {}),
    ...(body.temperature !== null && body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== null && body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.top_k !== null && body.top_k !== undefined ? { top_k: body.top_k } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
    ...(tools.length && body.tool_choice?.disable_parallel_tool_use === true ? { parallel_tool_calls: false } : {}),
    ...(forwardedToolChoice ? { tool_choice: forwardedToolChoice } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    ...(oc?.effort ? { reasoning_effort: oc.effort } : {}),
    ...(translatedResponseFormat ? { response_format: translatedResponseFormat } : {}),
    ...(cachePolicy.breakpointCount > 0 ? { __cachePolicy: cachePolicy } : {}),
  };
  return { openAI, cachePolicy };
}

// ----------------------------------------------------------------------------
// OpenAI → Anthropic response translation
// ----------------------------------------------------------------------------

export function buildAnthropicUsage(usage: Record<string, unknown>, cachePolicy: AnthropicCachePolicy | null): AnthropicUsage {
  const cacheRead = (usage.cache_read_input_tokens as number | undefined)
    ?? (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens
    ?? 0;
  const promptTotal = (usage.prompt_tokens as number | undefined) ?? (usage.input_tokens as number | undefined) ?? 0;
  let cacheCreationFlat = (usage.cache_creation_input_tokens as number | undefined) || 0;
  let split: AnthropicUsage["cache_creation"];
  const usageCacheCreation = usage.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined;
  if (usageCacheCreation && typeof usageCacheCreation === "object") {
    split = {
      ephemeral_5m_input_tokens: usageCacheCreation.ephemeral_5m_input_tokens || 0,
      ephemeral_1h_input_tokens: usageCacheCreation.ephemeral_1h_input_tokens || 0,
    };
  } else {
    split = cachePolicy?.has1h
      ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreationFlat }
      : { ephemeral_5m_input_tokens: cacheCreationFlat, ephemeral_1h_input_tokens: 0 };
  }

  const upstreamGaveCache = cacheCreationFlat > 0 || cacheRead > 0;
  let usedEstimate = false;
  const safePolicy = cachePolicy || { estCacheCreationTokens: 0, est5mTokens: 0, est1hTokens: 0, minCacheablePrefix: 0, breakpointCount: 0, has1h: false };
  const estAboveFloor = (safePolicy.estCacheCreationTokens ?? 0) >= safePolicy.minCacheablePrefix;
  if (!upstreamGaveCache && safePolicy.breakpointCount > 0 && safePolicy.estCacheCreationTokens > 0 && estAboveFloor) {
    usedEstimate = true;
    cacheCreationFlat = safePolicy.estCacheCreationTokens;
    if (promptTotal > 0) cacheCreationFlat = Math.min(cacheCreationFlat, promptTotal);
    const est5m = safePolicy.est5mTokens ?? 0;
    const est1h = safePolicy.est1hTokens ?? 0;
    const estTotal = est5m + est1h;
    if (estTotal > 0) {
      const scale = cacheCreationFlat / estTotal;
      const scaled1h = Math.round(est1h * scale);
      split = { ephemeral_5m_input_tokens: cacheCreationFlat - scaled1h, ephemeral_1h_input_tokens: scaled1h };
    } else {
      split = safePolicy.has1h
        ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreationFlat }
        : { ephemeral_5m_input_tokens: cacheCreationFlat, ephemeral_1h_input_tokens: 0 };
    }
  }

  const freshInput = usedEstimate
    ? Math.max(0, promptTotal - cacheRead - cacheCreationFlat)
    : Math.max(0, promptTotal - cacheRead);

  return {
    input_tokens: freshInput,
    output_tokens: (usage.completion_tokens as number | undefined) ?? (usage.output_tokens as number | undefined) ?? 0,
    cache_creation_input_tokens: cacheCreationFlat,
    cache_read_input_tokens: cacheRead,
    cache_creation: split,
    server_tool_use: (usage.server_tool_use as { web_search_requests?: number } | undefined) ?? { web_search_requests: 0 },
    service_tier: (usage.service_tier as string | undefined) ?? "standard",
  };
}

export function openAIToAnthropic(
  result: {
    choices?: {
      message?: {
        content?: string | null;
        reasoning_content?: string;
        reasoning_signature?: string;
        tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
      };
      finish_reason?: "stop" | "tool_calls" | "length" | "content_filter" | null;
    }[];
    model?: string;
    usage?: Record<string, unknown>;
  },
  model: string,
  msgId: string,
  cachePolicy: AnthropicCachePolicy | null,
  stopSequences?: string[],
): {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<Record<string, unknown>>;
  container: null;
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: AnthropicUsage;
} {
  const choice = result.choices?.[0];
  const content: Array<Record<string, unknown>> = [];
  if (choice?.message?.reasoning_content) {
    content.push({ type: "thinking", thinking: choice.message.reasoning_content, signature: choice.message.reasoning_signature || "" });
  }
  if (choice?.message?.tool_calls?.length) {
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = { __raw_arguments: tc.function.arguments || "" }; }
      content.push({ type: "tool_use", id: tc.id || `toolu_${Math.random().toString(36).slice(2, 14)}`, name: tc.function.name || "unknown", input });
    }
  } else {
    content.push({ type: "text", text: choice?.message?.content || "" });
  }
  const finalText = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const { stopReason, stopSequence } = resolveStopSequence(choice?.finish_reason, finalText, stopSequences);
  return {
    id: msgId,
    type: "message",
    role: "assistant",
    content,
    container: null,
    model: model || result.model || "",
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage: buildAnthropicUsage(result.usage || {}, cachePolicy),
  };
}

// ----------------------------------------------------------------------------
// Streaming translator
// ----------------------------------------------------------------------------

interface OpenAIChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning?: string;
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    cache_read_input_tokens?: number;
  };
}

export class AnthropicStreamTranslator {
  private res: { write: (chunk: string) => void; writableEnded?: boolean };
  private msgId: string;
  private model: string;
  private cachePolicy: AnthropicCachePolicy | null;
  private inputEstimate: number;
  private current: { type: string; index: number } | null = null;
  private blockIndex = 0;
  private toolCallBufs = new Map<number, { id: string; name: string; argsBuffered: string }>();
  private finalUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  } | null = null;
  private stopReason = "end_turn";
  private stopSequences: string[];
  private maxStopSeqLen = 0;
  private emittedTextTail = "";
  private messageStarted = false;
  private messageStopped = false;
  private pendingSseBuf = "";
  private pendingThinkingSignature = "";
  private accText = "";

  constructor(res: ServerResponse, msgId: string, model: string, cachePolicy: AnthropicCachePolicy | null, inputEstimate = 0, stopSequences: string[] | null = null) {
    this.res = res;
    this.msgId = msgId;
    this.model = model;
    this.cachePolicy = cachePolicy;
    this.inputEstimate = inputEstimate;
    this.stopSequences = Array.isArray(stopSequences) ? stopSequences.filter((s) => typeof s === "string" && s) : [];
    this.maxStopSeqLen = this.stopSequences.reduce((m, s) => Math.max(m, s.length), 0);
  }

  private send(event: string, data: Record<string, unknown>): void {
    if (!this.res.writableEnded) {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  private sendPing(): void {
    this.send("ping", { type: "ping" });
  }

  startMessage(): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    const startUsage = buildAnthropicUsage({ prompt_tokens: this.inputEstimate }, this.cachePolicy);
    this.send("message_start", {
      type: "message_start",
      message: {
        id: this.msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        usage: {
          input_tokens: startUsage.input_tokens,
          output_tokens: 0,
          cache_creation_input_tokens: startUsage.cache_creation_input_tokens,
          cache_read_input_tokens: startUsage.cache_read_input_tokens,
          cache_creation: startUsage.cache_creation,
        },
      },
    });
    this.sendPing();
  }

  private openTextBlock(): void {
    this.send("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } });
    this.current = { type: "text", index: this.blockIndex };
  }

  private openThinkingBlock(): void {
    this.send("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "" } });
    this.current = { type: "thinking", index: this.blockIndex };
  }

  private openToolBlock(id: string, name: string): void {
    this.send("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    this.toolCallBufs.set(this.blockIndex, { id, name, argsBuffered: "" });
    this.current = { type: "tool_use", index: this.blockIndex };
  }

  private closeBlock(): void {
    if (!this.current) return;
    if (this.current.type === "thinking" && this.pendingThinkingSignature) {
      this.send("content_block_delta", { type: "content_block_delta", index: this.current.index, delta: { type: "signature_delta", signature: this.pendingThinkingSignature } });
      this.pendingThinkingSignature = "";
    }
    this.send("content_block_stop", { type: "content_block_stop", index: this.current.index });
    this.blockIndex++;
    this.current = null;
  }

  private writeTextDelta(text: string): void {
    if (!text) return;
    this.send("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text } });
    this.accText += text;
    if (this.maxStopSeqLen > 0) {
      this.emittedTextTail += text;
      const tailLen = this.maxStopSeqLen + 32;
      if (this.emittedTextTail.length > tailLen) this.emittedTextTail = this.emittedTextTail.slice(-tailLen);
    }
  }

  private writeToolArgsDelta(argsDelta: string): void {
    if (!argsDelta) return;
    const buf = this.toolCallBufs.get(this.blockIndex);
    if (buf) buf.argsBuffered += argsDelta;
    this.send("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "input_json_delta", partial_json: argsDelta } });
  }

  private writeThinkingDelta(thinking: string, signature?: string): void {
    if (!thinking) return;
    this.send("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "thinking_delta", thinking } });
    if (signature) this.pendingThinkingSignature = signature;
  }

  handleOpenAIChunk(chunk: OpenAIChunk): void {
    if (!this.messageStarted) this.startMessage();
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (!delta) return;

    if (delta.content) {
      if (this.current?.type === "tool_use") this.closeBlock();
      if (this.current?.type === "thinking") this.closeBlock();
      if (!this.current) this.openTextBlock();
      this.writeTextDelta(delta.content);
    }

    if (delta.reasoning) {
      if (this.current?.type === "text") this.closeBlock();
      if (this.current?.type === "tool_use") this.closeBlock();
      if (!this.current) this.openThinkingBlock();
      this.writeThinkingDelta(delta.reasoning);
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          if (this.current) this.closeBlock();
          const id = tc.id || `toolu_${Math.random().toString(36).slice(2, 14)}`;
          this.openToolBlock(id, tc.function.name);
        }
        if (tc.function?.arguments) {
          this.writeToolArgsDelta(tc.function.arguments);
        }
      }
    }

    if (choice.finish_reason) {
      this.stopReason = choice.finish_reason;
    }

    if (chunk.usage) {
      this.finalUsage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
        cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: chunk.usage.cache_read_input_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cache_creation: chunk.usage.cache_creation,
      };
    }
  }

  finish(): void {
    if (this.messageStopped) return;
    this.messageStopped = true;
    if (!this.messageStarted) this.startMessage();
    if (this.current) this.closeBlock();

    const finalText = this.accText;
    const { stopReason, stopSequence } = resolveStopSequence(this.stopReason, finalText, this.stopSequences);
    const usage = buildAnthropicUsage(
      {
        prompt_tokens: this.finalUsage?.input_tokens ?? this.inputEstimate,
        completion_tokens: this.finalUsage?.output_tokens ?? 0,
        cache_creation_input_tokens: this.finalUsage?.cache_creation_input_tokens,
        cache_read_input_tokens: this.finalUsage?.cache_read_input_tokens,
        cache_creation: this.finalUsage?.cache_creation,
      } as Record<string, unknown>,
      this.cachePolicy,
    );

    this.send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: stopSequence },
      usage: { output_tokens: usage.output_tokens },
    });
    this.send("message_stop", { type: "message_stop" });
  }

  error(message: string): void {
    if (this.messageStopped) return;
    this.messageStopped = true;
    this.send("error", { type: "error", error: { type: "api_error", message } });
  }

  parseAndHandleSseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("data: ")) {
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") {
        return;
      }
      try {
        const chunk = JSON.parse(payload) as OpenAIChunk;
        this.handleOpenAIChunk(chunk);
      } catch {
        // ignore malformed JSON
      }
    } else if (trimmed.startsWith(":")) {
      // SSE comment / heartbeat
      this.sendPing();
    }
  }

  handleRawSseData(raw: string): void {
    this.pendingSseBuf += raw;
    const lines = this.pendingSseBuf.split("\n");
    this.pendingSseBuf = lines.pop() || "";
    for (const line of lines) this.parseAndHandleSseLine(line);
  }
}

export function openAIUsageFromRaw(raw: unknown): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
} {
  const u = (raw as { usage?: Record<string, unknown> }).usage || {};
  return {
    promptTokens: (u.prompt_tokens as number | undefined) ?? (u.input_tokens as number | undefined),
    completionTokens: (u.completion_tokens as number | undefined) ?? (u.output_tokens as number | undefined),
    totalTokens: u.total_tokens as number | undefined,
    cachedInputTokens: (u.cache_read_input_tokens as number | undefined) ?? (u.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens as number | undefined,
    reasoningTokens: (u.reasoning_tokens as number | undefined) ?? (u.completion_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens,
  };
}
