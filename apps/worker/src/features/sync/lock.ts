import { renewSyncJobLock } from "../../db";
import type { ConnectorId } from "@taiwan-fin-hub/shared";

export const SYNC_LOCK_LEASE_MS = 30 * 60 * 1000;

const SYNC_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;

export function startSyncLockHeartbeat(
  db: D1Database,
  lockRowId: string,
  runId: string,
) {
  const timer = setInterval(() => {
    void renewSyncJobLock(db, { lockRowId, runId, leaseMs: SYNC_LOCK_LEASE_MS })
      .then((renewed) => {
        if (!renewed)
          console.error(`[sync] lock heartbeat lost for ${lockRowId}`);
      })
      .catch((error) =>
        console.error(`[sync] lock heartbeat failed for ${lockRowId}`, error),
      );
  }, SYNC_LOCK_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

export function canonicalSyncLockRowId(connectorId: ConnectorId) {
  return `${connectorId}:all`;
}
