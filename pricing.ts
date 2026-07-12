/**
 * Model pricing data — per 1M tokens, in USD.
 *
 * Sources:
 * - Devin Docs self-serve pricing table (https://docs.devin.ai/desktop/models)
 * - Anthropic platform pricing (https://platform.claude.com/docs/en/about-claude/pricing)
 * - OpenAI API pricing (https://developers.openai.com/api/docs/pricing)
 *
 * Windsurf's catalog only exposes a `hasPricing` boolean (proto field #32) — it does
 * NOT include actual per-token prices. We maintain this table as the source of truth
 * and match catalog model UIDs by prefix.
 *
 * All thinking levels (Low/Medium/High/XHigh/Max) and Fast variants within the same
 * model family share the same per-token price — thinking level only affects how many
 * tokens are generated, not the per-token rate.
 *
 * Free-promo models (promoActive=true in catalog) still get cost populated so Pi can
 * show "what this would cost at API rates", but the model name is tagged [Free Promo]
 * so users know it doesn't count against their quota.
 */

export interface ModelPricing {
  input: number;
  cacheRead: number;
  output: number;
  cacheWrite: number;
}

/**
 * Pricing table keyed by UID prefix. The longest matching prefix wins.
 * Prices are per 1M tokens in USD. cacheWrite is estimated as 1.25x input
 * (typical Anthropic/OpenAI cache-write premium) when not explicitly known.
 */
const PRICING_TABLE: Record<string, ModelPricing> = {
  // --- Cognition SWE family ---
  "swe-1-7-lightning": { input: 2.5, cacheRead: 1.0, output: 12.5, cacheWrite: 3.125 },
  // SWE-1.7, SWE-1.6, SWE-1.5, SWE-1, SWE-1-mini: free / no published per-token price
  "swe-1-7": { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 },
  "swe-1-6": { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 },
  "swe-1-6-fast": { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 },
  "swe-1-5": { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 },
  "MODEL_SWE": { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 },

  // --- Adaptive (router) ---
  "adaptive": { input: 0.5, cacheRead: 0.1, output: 2.0, cacheWrite: 0.625 },

  // --- Claude family (Anthropic) ---
  // Fable 5
  "claude-5-fable": { input: 10.0, cacheRead: 1.0, output: 50.0, cacheWrite: 12.5 },
  // Sonnet 5 (introductory $2/$10 through Aug 31 2026, then $3/$15 — Windsurf shows $3/$15)
  "claude-sonnet-5": { input: 3.0, cacheRead: 0.3, output: 15.0, cacheWrite: 3.75 },
  // Sonnet 4.6
  "claude-sonnet-4-6": { input: 3.0, cacheRead: 0.3, output: 15.0, cacheWrite: 3.75 },
  // Sonnet 4.5
  "claude-sonnet-4-5": { input: 3.0, cacheRead: 0.3, output: 15.0, cacheWrite: 3.75 },
  // Opus 4.8
  "claude-opus-4-8": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },
  // Opus 4.7
  "claude-opus-4-7": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },
  // Opus 4.6
  "claude-opus-4-6": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },
  // Opus 4.5
  "claude-opus-4-5": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },
  // Haiku 4.5
  "claude-haiku-4-5": { input: 1.0, cacheRead: 0.1, output: 5.0, cacheWrite: 1.25 },
  // Legacy Claude enum UIDs
  "MODEL_CLAUDE_SONNET_4_5": { input: 3.0, cacheRead: 0.3, output: 15.0, cacheWrite: 3.75 },
  "MODEL_CLAUDE_4_5_SONNET": { input: 3.0, cacheRead: 0.3, output: 15.0, cacheWrite: 3.75 },
  "MODEL_CLAUDE_OPUS_4_5": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },
  "MODEL_CLAUDE_4_5_OPUS": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },
  // MODEL_PRIVATE_2/3 = Claude Sonnet 4.5 (from catalog label mapping)
  "MODEL_PRIVATE_2": { input: 3.0, cacheRead: 0.3, output: 15.0, cacheWrite: 3.75 },
  "MODEL_PRIVATE_3": { input: 3.0, cacheRead: 0.3, output: 15.0, cacheWrite: 3.75 },
  // MODEL_PRIVATE_11 = Claude Haiku 4.5
  "MODEL_PRIVATE_11": { input: 1.0, cacheRead: 0.1, output: 5.0, cacheWrite: 1.25 },

  // --- GPT family (OpenAI) ---
  // GPT-5.6 (Sol/Terra/Luna) — no published Windsurf price; infer from 5.5
  "gpt-5-6": { input: 5.0, cacheRead: 0.5, output: 30.0, cacheWrite: 6.25 },
  // GPT-5.5
  "gpt-5-5": { input: 5.0, cacheRead: 0.5, output: 30.0, cacheWrite: 6.25 },
  // GPT-5.4
  "gpt-5-4": { input: 2.5, cacheRead: 0.25, output: 15.0, cacheWrite: 3.125 },
  // GPT-5.4 Mini
  "gpt-5-4-mini": { input: 0.4, cacheRead: 0.04, output: 1.6, cacheWrite: 0.5 },
  // GPT-5.3-Codex — infer from 5.2-Codex lineage
  "gpt-5-3-codex": { input: 1.75, cacheRead: 0.175, output: 14.0, cacheWrite: 2.1875 },
  // GPT-5.2
  "gpt-5-2": { input: 1.75, cacheRead: 0.175, output: 14.0, cacheWrite: 2.1875 },
  "MODEL_GPT_5_2": { input: 1.75, cacheRead: 0.175, output: 14.0, cacheWrite: 2.1875 },

  // --- Gemini family (Google) ---
  // Gemini 3.5 Flash — no published per-token Windsurf price; estimate from Google API
  "gemini-3-5-flash": { input: 0.15, cacheRead: 0.0375, output: 0.6, cacheWrite: 0.1875 },
  // Gemini 3.1 Pro
  "gemini-3-1-pro": { input: 2.0, cacheRead: 0.5, output: 12.0, cacheWrite: 2.5 },
  // Gemini 3 Flash
  "gemini-3-flash": { input: 0.15, cacheRead: 0.0375, output: 0.6, cacheWrite: 0.1875 },
  "MODEL_GOOGLE_GEMINI_3_0_FLASH": { input: 0.15, cacheRead: 0.0375, output: 0.6, cacheWrite: 0.1875 },

  // --- DeepSeek ---
  "deepseek-v4": { input: 1.74, cacheRead: 0.15, output: 3.48, cacheWrite: 2.175 },
  "deepseek": { input: 1.74, cacheRead: 0.15, output: 3.48, cacheWrite: 2.175 },

  // --- GLM (Zhipu) ---
  "glm-5-2": { input: 1.4, cacheRead: 0.26, output: 4.4, cacheWrite: 1.75 },
  "glm": { input: 1.4, cacheRead: 0.26, output: 4.4, cacheWrite: 1.75 },

  // --- Kimi (Moonshot) ---
  "kimi-k2-7": { input: 0.95, cacheRead: 0.19, output: 4.0, cacheWrite: 1.1875 },
  "kimi-k2-6": { input: 0.95, cacheRead: 0.16, output: 4.0, cacheWrite: 1.1875 },
  "kimi": { input: 0.95, cacheRead: 0.19, output: 4.0, cacheWrite: 1.1875 },

  // --- Grok (xAI) ---
  "grok-4-5": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },
  "grok": { input: 5.0, cacheRead: 0.5, output: 25.0, cacheWrite: 6.25 },

  // --- Nemotron (NVIDIA) ---
  "nemotron-3": { input: 0.5, cacheRead: 0.05, output: 2.0, cacheWrite: 0.625 },
};

const ZERO_PRICING: ModelPricing = { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 };

/**
 * Look up pricing for a model UID by longest matching prefix.
 * Returns zero pricing if no match found.
 */
export function getPricingForModelUid(modelUid: string): ModelPricing {
  // Try exact match first, then progressively shorter prefixes
  const uid = modelUid.toLowerCase();
  // Sort keys by length descending for longest-prefix match
  const keys = Object.keys(PRICING_TABLE).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (uid.startsWith(key.toLowerCase())) {
      return PRICING_TABLE[key];
    }
  }
  return ZERO_PRICING;
}
