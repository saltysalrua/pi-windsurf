/**
 * AssignModel + GetUserStatus RPCs.
 *
 * AssignModel resolves a model-router UID to a concrete backend model + assignment_jwt.
 * GetUserStatus fetches account/plan/quota info.
 */
import * as crypto from "crypto";
import { buildMetadata } from "./metadata";
import { getCachedUserJwt } from "./auth";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "./wire";

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
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
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
  let harnessUids: string[] = [];

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
  const userJwt = await getCachedUserJwt(apiKey, host, signal);
  const metadata = buildMetadata({
    apiKey, userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  const body = encodeMessage(1, metadata);

  const timeoutSignal = AbortSignal.timeout(STATUS_TIMEOUT_MS);
  const combinedSignal = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;

  const resp = await fetch(`${host.replace(/\/$/, "")}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body,
    signal: combinedSignal,
  });
  const buf = Buffer.from(await resp.arrayBuffer());

  if (!resp.ok) {
    const text = buf.toString("utf8");
    throw new Error(`GetUserStatus HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  return decodeUserStatus(buf);
}

function decodeUserStatus(buf: Buffer): UserStatus {
  const status: UserStatus = {};
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // user_status (field 1)
      decodeUserStatusFields(f.value as Buffer, status);
    } else if (f.num === 2 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // plan_info (field 2)
      decodePlanInfoFields(f.value as Buffer, status);
    }
  }
  return status;
}

function decodeUserStatusFields(buf: Buffer, status: UserStatus): void {
  for (const sf of iterFields(buf)) {
    if (sf.num === 3 && sf.wire === 0) status.isPro = sf.value === 1n;
    else if (sf.num === 4 && sf.wire === 0) status.isTeams = sf.value === 1n;
    else if (sf.num === 5 && sf.wire === 0) status.isEnterprise = sf.value === 1n;
    else if (sf.num === 6 && sf.wire === 0) status.hasPaidFeatures = sf.value === 1n;
    else if (sf.num === 7 && sf.wire === 0) status.browserEnabled = sf.value === 1n;
    else if (sf.num === 8 && sf.wire === 0) status.canUseCascade = sf.value === 1n;
    else if (sf.num === 9 && sf.wire === 0) status.canUseCli = sf.value === 1n;
    else if (sf.num === 10 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
      status.windsurfProTrialEndTime = (sf.value as Buffer).toString("utf8");
    }
  }
}

function decodePlanInfoFields(buf: Buffer, status: UserStatus): void {
  for (const sf of iterFields(buf)) {
    if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) status.planName = (sf.value as Buffer).toString("utf8");
    else if (sf.num === 2 && sf.wire === 0) status.monthlyPromptCredits = Number(sf.value);
    else if (sf.num === 3 && sf.wire === 0) status.availablePromptCredits = Number(sf.value);
    else if (sf.num === 4 && sf.wire === 0) status.usedPromptCredits = Number(sf.value);
    else if (sf.num === 5 && sf.wire === 0) status.monthlyFlowCredits = Number(sf.value);
    else if (sf.num === 6 && sf.wire === 0) status.availableFlowCredits = Number(sf.value);
    else if (sf.num === 7 && sf.wire === 0) status.usedFlowCredits = Number(sf.value);
    else if (sf.num === 8 && sf.wire === 0) status.dailyQuotaRemainingPercent = Number(sf.value);
    else if (sf.num === 9 && sf.wire === 0) status.weeklyQuotaRemainingPercent = Number(sf.value);
  }
}
