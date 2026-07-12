/**
 * Minimal model resolution — catalog is the single source of truth.
 *
 * This file only exists because the proxy needs synchronous model resolution.
 * All model metadata, UIDs, pricing, promos come from the catalog.
 */

export interface ResolvedModel {
	modelId: string;
	modelUid: string;
	variant?: string;
}

/**
 * Resolve a user-provided model name to a canonical UID.
 * Uses the catalog's display-name → UID mapping when available.
 * Falls back to pass-through if no catalog entry matches.
 */
export async function resolveModelName(
	modelName: string,
	apiKey?: string,
	host?: string,
	thinkingLevel?: string,
): Promise<ResolvedModel> {
	if (!apiKey || !host) return { modelId: modelName, modelUid: modelName };
	try {
		const { getCachedCatalog } = await import("./catalog");
		const catalog = await getCachedCatalog(apiKey, host);
		if (!catalog) return { modelId: modelName, modelUid: modelName };

		const match = findCatalogEntry(catalog, modelName);
		if (!match) {
			// Model name might be a family prefix (e.g. "gpt-5-4" → find "gpt-5-4-high")
			const fallback = findFamilyEntry(catalog, modelName, thinkingLevel);
			if (fallback)
				return {
					modelId: modelName,
					modelUid: fallback.uid,
					variant: fallback.label,
				};
			return { modelId: modelName, modelUid: modelName };
		}

		// Apply thinking level: find sibling in same family whose label contains the level
		if (thinkingLevel && catalog.byUid.size > 1) {
			const levelWord = thinkingLevelToWord(thinkingLevel);
			if (levelWord) {
				const sibling = findSiblingByLevel(
					catalog,
					match.uid,
					match.label,
					levelWord,
				);
				if (sibling)
					return {
						modelId: modelName,
						modelUid: sibling.uid,
						variant: sibling.label,
					};
			}
		}

		return { modelId: modelName, modelUid: match.uid, variant: match.label };
	} catch {}
	return { modelId: modelName, modelUid: modelName };
}

/** Map Pi thinking level string to a label-searchable word. */
function thinkingLevelToWord(level: string): string | null {
	const l = level.toLowerCase();
	if (l === "off") return "no";
	// Pi levels: minimal, low, medium, high, xhigh → search catalog labels
	return l;
}

/** Normalize a model name or UID for fuzzy matching.
 *  MODEL_GPT_5_2_LOW → gpt-5-2-low, gpt-5-2-low → gpt-5-2-low
 *  MODEL_PRIVATE_* entries are mapped to their friendly slug equivalents. */
const PRIVATE_UID_MAP: Record<string, string> = {
	MODEL_PRIVATE_11: "claude-haiku-4-5",
	MODEL_PRIVATE_2: "claude-sonnet-4-5",
	MODEL_PRIVATE_3: "claude-sonnet-4-5",
};

function normalizeForMatch(s: string): string {
	if (PRIVATE_UID_MAP[s.toUpperCase()]) return PRIVATE_UID_MAP[s.toUpperCase()];
	return s
		.replace(/^MODEL_/, "")
		.replace(/^GOOGLE_/, "")
		.toLowerCase()
		.replace(/_/g, "-");
}

/** Find a catalog entry by UID or label match. */
function findCatalogEntry(
	catalog: { byUid: Map<string, { modelUid: string; label: string }> },
	modelName: string,
): { uid: string; label: string } | null {
	const lower = modelName.toLowerCase();
	// Exact UID
	if (catalog.byUid.has(modelName)) {
		const e = catalog.byUid.get(modelName)!;
		return { uid: e.modelUid, label: e.label };
	}
	// Case-insensitive UID
	for (const [uid, entry] of catalog.byUid) {
		if (uid.toLowerCase() === lower)
			return { uid: entry.modelUid, label: entry.label };
	}
	// Display-name match
	for (const [, entry] of catalog.byUid) {
		if (entry.label.toLowerCase() === lower)
			return { uid: entry.modelUid, label: entry.label };
	}
	// Normalized match: strip MODEL_ prefix and convert _ to - for legacy UIDs
	const normalized = normalizeForMatch(lower);
	for (const [uid, entry] of catalog.byUid) {
		const uidNorm = normalizeForMatch(uid);
		const labelNorm = entry.label.toLowerCase().replace(/[^a-z0-9]/g, "");
		const inputNorm = normalized.replace(/[^a-z0-9]/g, "");
		if (uidNorm === normalized || uidNorm.replace(/[^a-z0-9]/g, "") === inputNorm || labelNorm === inputNorm) {
			return { uid: entry.modelUid, label: entry.label };
		}
	}
	return null;
}

/**
 * When input is a family prefix (e.g. "gpt-5-4"), find the best entry.
 * If thinkingLevel is given, prefer the matching variant.
 * Otherwise, prefer the first alphabetically (usually "high" or default).
 */
function findFamilyEntry(
	catalog: { byUid: Map<string, { modelUid: string; label: string }> },
	modelName: string,
	thinkingLevel?: string,
): { uid: string; label: string } | null {
	const lower = modelName.toLowerCase();
	const normalized = normalizeForMatch(lower);
	// Find all UIDs that start with the model name (try both raw and normalized)
	const candidates: { uid: string; label: string }[] = [];
	for (const [uid, entry] of catalog.byUid) {
		const uidLower = uid.toLowerCase();
		const uidNorm = normalizeForMatch(uid);
		if (
			uidLower.startsWith(lower + "-") ||
			uidLower.startsWith(lower) ||
			uidNorm.startsWith(normalized + "-") ||
			uidNorm.startsWith(normalized)
		) {
			candidates.push({ uid: entry.modelUid, label: entry.label });
		}
	}
	if (candidates.length === 0) return null;
	// If thinking level specified, try to find matching label
	if (thinkingLevel) {
		const levelWord = thinkingLevelToWord(thinkingLevel);
		if (levelWord) {
			for (const c of candidates) {
				if (c.label.toLowerCase().includes(levelWord)) return c;
			}
		}
	}
	// Return first candidate (default variant)
	return candidates[0];
}

/**
 * Find a sibling catalog entry whose label contains the thinking level word.
 * "Sibling" = entries sharing a UID prefix (same model family).
 * Prefers siblings that share the same variant suffixes (1M, fast/priority)
 * as the current entry to avoid crossing variant boundaries.
 * Completely data-driven from catalog labels — no hardcoded suffix lists.
 */
function findSiblingByLevel(
	catalog: { byUid: Map<string, { modelUid: string; label: string }> },
	currentUid: string,
	currentLabel: string,
	levelWord: string,
): { uid: string; label: string } | null {
	const currentLabelLower = currentLabel.toLowerCase();
	if (currentLabelLower.includes(levelWord)) {
		return { uid: currentUid, label: currentLabel };
	}
	// Detect variant suffixes on the current UID to prefer same-variant siblings
	const is1M = /-1m$/.test(currentUid);
	const isFast = /-(?:fast|priority)$/.test(currentUid);

	// Search progressively shorter prefixes. Stop only on a label match or when exhausted.
	for (let len = currentUid.length - 1; len > 2; len--) {
		const prefix = currentUid.slice(0, len);
		const candidates: { uid: string; label: string }[] = [];
		for (const [uid, entry] of catalog.byUid) {
			if (uid === currentUid) continue;
			if (uid.startsWith(prefix)) {
				candidates.push({ uid: entry.modelUid, label: entry.label });
			}
		}
		if (candidates.length === 0) continue;
		// Prefer same-variant siblings first
		const sameVariant = candidates.filter(
			(c) =>
				is1M === /-1m$/.test(c.uid) &&
				isFast === /-(?:fast|priority)$/.test(c.uid),
		);
		for (const c of sameVariant) {
			if (c.label.toLowerCase().includes(levelWord)) return c;
		}
		// Fall back to any sibling
		for (const c of candidates) {
			if (c.label.toLowerCase().includes(levelWord)) return c;
		}
		// Found siblings but none match — keep searching shorter prefixes
	}
	return null;
}

/** Synchronous pass-through fallback — use resolveModelName when possible. */
export function resolveModelOrPassthrough(modelName: string): ResolvedModel {
	return { modelId: modelName, modelUid: modelName };
}

export function getDefaultModel(): string {
	return "";
}

export function getCanonicalModels(): string[] {
	return [];
}
