/**
 * AssignModel + GetUserStatus RPCs.
 *
 * AssignModel resolves a model-router UID to a concrete backend model + assignment_jwt.
 * GetUserStatus fetches account/plan/quota info.
 */
import * as crypto from "node:crypto";
import { buildMetadata } from "./metadata.ts";
import { getCachedUserJwt } from "./auth.ts";
import { encodeMessage, encodeString, iterFields } from "./wire.ts";

// ----------------------------------------------------------------------------
// Normalization helpers
// ----------------------------------------------------------------------------
const numberValue = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
};
const booleanValue = (...values: unknown[]): boolean | undefined => {
  for (const value of values) if (typeof value === "boolean") return value;
  return undefined;
};
const hundredths = (...values: unknown[]): number | undefined => {
  const n = numberValue(...values);
  return n === undefined ? undefined : n / 100;
};

function normalizeJsonUserStatus(data: Record<string, unknown>): UserStatus {
  const userStatus = (data.userStatus ?? data.user_status ?? {}) as Record<string, unknown>;
  const planStatus = (userStatus.planStatus ?? userStatus.plan_status ?? {}) as Record<string, unknown>;
  const planInfo = (planStatus.planInfo ?? planStatus.plan_info ?? {}) as Record<string, unknown>;

  return {
    planName: String(planInfo.planName ?? planInfo.plan_name ?? "Unknown"),
    isPro: booleanValue(userStatus.isPro, userStatus.is_pro),
    isTeams: booleanValue(userStatus.isTeams, userStatus.is_teams),
    isEnterprise: booleanValue(userStatus.isEnterprise, userStatus.is_enterprise),
    monthlyPromptCredits: hundredths(planInfo.monthlyPromptCredits, planInfo.monthly_prompt_credits),
    availablePromptCredits: hundredths(planStatus.availablePromptCredits, planStatus.available_prompt_credits),
    usedPromptCredits: hundredths(planStatus.usedPromptCredits, planStatus.used_prompt_credits),
    monthlyFlowCredits: hundredths(
      planInfo.monthlyFlexCreditPurchaseAmount,
      planInfo.monthly_flex_credit_purchase_amount,
      planInfo.monthlyFlowCredits,
      planInfo.monthly_flow_credits,
    ),
    availableFlowCredits: hundredths(
      planStatus.availableFlexCredits,
      planStatus.available_flex_credits,
      planStatus.availableFlowCredits,
      planStatus.available_flow_credits,
    ),
    usedFlowCredits: hundredths(
      planStatus.usedFlexCredits,
      planStatus.used_flex_credits,
      planStatus.usedFlowCredits,
      planStatus.used_flow_credits,
    ),
    dailyQuotaRemainingPercent: numberValue(
      planStatus.dailyQuotaRemainingPercent,
      planStatus.daily_quota_remaining_percent,
    ),
    weeklyQuotaRemainingPercent: numberValue(
      planStatus.weeklyQuotaRemainingPercent,
      planStatus.weekly_quota_remaining_percent,
    ),
    hasPaidFeatures: booleanValue(userStatus.hasPaidFeatures, userStatus.has_paid_features),
    browserEnabled: booleanValue(userStatus.browserEnabled, userStatus.browser_enabled),
    canUseCascade: booleanValue(userStatus.canUseCascade, userStatus.can_use_cascade),
    canUseCli: booleanValue(userStatus.canUseCli, userStatus.can_use_cli),
    windsurfProTrialEndTime:
      typeof userStatus.windsurfProTrialEndTime === "string"
        ? userStatus.windsurfProTrialEndTime
        : undefined,
  };
}

// ----------------------------------------------------------------------------
// AssignModel
// ----------------------------------------------------------------------------

export interface ModelAssignment {
  modelUid: string;
  assignmentJwt: string;
  harnessUids: string[];
}

const ASSIGN_TIMEOUT_MS = 15_000;
const assignmentCache = new Map<string, { assignment: ModelAssignment; expiresAt: number }>();
const ASSIGN_TTL_MS = 5 * 60 * 1000;

function anySignal(signals: AbortSignal[]): AbortSignal {
  const builtin = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof builtin === "function") return builtin(signals);
  const controller = new AbortController();
  const onAbort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of signals) {
    if (s.aborted) { onAbort(s.reason); break; }
    s.addEventListener("abort", () => onAbort(s.reason), { once: true });
  }
  return controller.signal;
}

export async function assignModel(
  apiKey: string,
  host: string,
  modelUid: string,
  signal?: AbortSignal,
): Promise<ModelAssignment> {
  const cacheKey = `${host}\x1f${apiKey}\x1f${modelUid}`;
  const cached = assignmentCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.assignment;

  const userJwt = await getCachedUserJwt(apiKey, host, signal);
  const metadata = buildMetadata({
    apiKey, userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  const body = Buffer.concat([
    encodeMessage(1, metadata),
    encodeString(2, modelUid),
  ]);

  const timeoutSignal = AbortSignal.timeout(ASSIGN_TIMEOUT_MS);
  const combinedSignal = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;

  const resp = await fetch(`${host.replace(/\/$/, "")}/exa.api_server_pb.ApiServerService/AssignModel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
    },
    body,
    signal: combinedSignal,
  });
  const buf = Buffer.from(await resp.arrayBuffer());

  if (!resp.ok) {
    const text = buf.toString("utf8");
    throw new Error(`AssignModel HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  let resolvedUid = "";
  let assignmentJwt = "";
  const harnessUids: string[] = [];

  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // AssignModelResponse.assignment (field 1) → ModelAssignment
      for (const sf of iterFields(f.value as Buffer)) {
        if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          resolvedUid = (sf.value as Buffer).toString("utf8");
        } else if (sf.num === 2 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          assignmentJwt = (sf.value as Buffer).toString("utf8");
        } else if (sf.num === 3 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          harnessUids.push((sf.value as Buffer).toString("utf8"));
        }
      }
    }
  }

  if (!resolvedUid) throw new Error("AssignModel returned empty assignment");
  if (!assignmentJwt) throw new Error("AssignModel returned no assignment_jwt");

  const assignment: ModelAssignment = { modelUid: resolvedUid, assignmentJwt, harnessUids };
  assignmentCache.set(cacheKey, { assignment, expiresAt: Date.now() + ASSIGN_TTL_MS });
  return assignment;
}

export function clearAssignmentCache(): void {
  assignmentCache.clear();
}

/**
 * Resolve a model UID: if it's a router, call AssignModel; otherwise pass through.
 * Returns the concrete model UID + optional assignment_jwt for the chat request.
 */
export async function resolveModel(
  apiKey: string,
  host: string,
  modelUid: string,
  isRouter: boolean,
  signal?: AbortSignal,
): Promise<{ modelUid: string; assignmentJwt?: string }> {
  if (!isRouter) return { modelUid };
  const assignment = await assignModel(apiKey, host, modelUid, signal);
  return { modelUid: assignment.modelUid, assignmentJwt: assignment.assignmentJwt };
}

// ----------------------------------------------------------------------------
// GetUserStatus
// ----------------------------------------------------------------------------

export interface UserStatus {
  planName?: string;
  isPro?: boolean;
  isTeams?: boolean;
  isEnterprise?: boolean;
  monthlyPromptCredits?: number;
  availablePromptCredits?: number;
  usedPromptCredits?: number;
  monthlyFlowCredits?: number;
  availableFlowCredits?: number;
  usedFlowCredits?: number;
  dailyQuotaRemainingPercent?: number;
  weeklyQuotaRemainingPercent?: number;
  hasPaidFeatures?: boolean;
  browserEnabled?: boolean;
  canUseCascade?: boolean;
  canUseCli?: boolean;
  windsurfProTrialEndTime?: string;
}

const STATUS_TIMEOUT_MS = 15_000;

export async function getUserStatus(
  apiKey: string,
  host: string,
  signal?: AbortSignal,
): Promise<UserStatus> {
  const timeoutSignal = AbortSignal.timeout(STATUS_TIMEOUT_MS);
  const combinedSignal = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;
  const normalizedHost = host.replace(/\/$/, "");

  // The public Connect gateway's current GetUserStatus contract is proto3 JSON.
  // This is also what WindsurfAPI uses; the old application/proto request shape
  // frequently returned an empty/undecodable response, which broke /windsurf-status.
  const metadata = {
    apiKey,
    ideName: "windsurf",
    ideVersion: "2026.8.18",
    extensionName: "windsurf",
    extensionVersion: "2026.8.18",
    locale: "en",
  };
  const resp = await fetch(`${normalizedHost}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify({ metadata }),
    signal: combinedSignal,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`GetUserStatus HTTP ${resp.status}: ${text.slice(0, 300)}`);

  try {
    return normalizeJsonUserStatus(JSON.parse(text) as Record<string, unknown>);
  } catch (error) {
    throw new Error(`GetUserStatus returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}


