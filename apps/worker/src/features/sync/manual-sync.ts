import type { Env } from "../../platform/env";
import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { type SyncScope, type SyncOutcome, SYNC_SCOPE_ALL } from "./types";
import {
  canonicalSyncLockRowId,
  SYNC_LOCK_LEASE_MS,
  startSyncLockHeartbeat,
} from "./lock";
import {
  acquireSyncJobLock,
  markManualSyncSuccess,
  type SyncStatus,
  markManualSyncFailure,
  releaseSyncJobLock,
} from "../../db";
import {
  SyncAlreadyRunningError,
  isUserActionError,
  safeErrorMessage,
} from "./errors";
import {
  findLatestRecoverableScheduledBatchId,
  recoverLatestScheduledSyncSource,
} from "./reports/repository";
import { beginActivityRun } from "./reports/activity-detail-repository";

export async function withManualSyncLock(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  task: () => Promise<SyncOutcome>,
) {
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope,
    trigger: "manual",
    runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });

  if (!locked) {
    throw new SyncAlreadyRunningError(connectorId);
  }

  const stopHeartbeat = startSyncLockHeartbeat(env.DB, lockRowId, runId);
  let recoveryBatchId: string | null = null;
  try {
    recoveryBatchId =
      connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL
        ? await findLatestRecoverableScheduledBatchId(env.DB, connectorId)
        : null;
    await beginActivityRun(env.DB, runId, recoveryBatchId, connectorId);
    const outcome = await task();
    await markManualSyncSuccess(env.DB, connectorId, scope);
    if (connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL) {
      await recoverLatestScheduledSyncSource(env.DB, {
        connectorId,
        newRecords: outcome.newRecords,
        batchId: recoveryBatchId,
        runId,
      }).catch((error) => {
        // A report repair must never turn an otherwise successful manual sync
        // into a failed sync response.
        console.error(
          "[sync] failed to recover latest scheduled report",
          error,
        );
      });
    }
    return outcome;
  } catch (error) {
    const status: SyncStatus = isUserActionError(error)
      ? "needs_user_action"
      : "failed";
    await markManualSyncFailure(env.DB, connectorId, scope, {
      status,
      errorMessage: safeErrorMessage(error),
    });
    throw error;
  } finally {
    stopHeartbeat();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}
