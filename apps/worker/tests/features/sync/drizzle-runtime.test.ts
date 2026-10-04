import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  acquireSyncJobLock,
  renewSyncJobLock,
  releaseSyncJobLock,
} from "../../../src/db";
import {
  acquireEinvoiceRunChunkLease,
  renewEinvoiceRunChunkLease,
  releaseEinvoiceRunChunkLease,
  createOrGetActiveEinvoiceRun,
  completeEinvoiceRun,
  claimEinvoiceRunSessionRefresh,
} from "../../../src/sources/einvoice/run-repository";
import {
  acquireTdccRunLease,
  renewTdccRunLease,
  releaseTdccRunLease,
  createOrGetActiveTdccRun,
  updateTdccRunState,
  finalizeTdccRun,
  claimTdccRunSessionRefresh,
} from "../../../src/sources/tdcc/run-repository";
import {
  stageSyncWriteRecords,
  promoteStagedSyncWrite,
} from "../../../src/features/sync/persistence";
import { connectorCursorStatement } from "../../../src/features/sync/connector-repository";

const now = "2026-09-13T00:00:00.000Z";

describe("同步鎖與原子寫入（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    const db = harness.binding;
    await db.batch([
      db.prepare("DROP TRIGGER IF EXISTS fail_run_update"),
      ...[
        "einvoice_sync_run_items",
        "einvoice_sync_runs",
        "tdcc_sync_run_items",
        "tdcc_sync_runs",
        "sync_write_staging",
        "invoices",
        "connector_settings",
        "sync_jobs",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    ]);
  });

  it("connector lock 競爭只有一方取得，舊 owner 不能續租或釋放", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, created_at, updated_at) VALUES ('tdcc:all', 'tdcc', 'all', 1440, ?, ?, ?)`,
      )
      .bind(now, now, now)
      .run();
    const input = {
      lockRowId: "tdcc:all",
      scope: "all",
      trigger: "manual" as const,
      leaseMs: 60_000,
    };
    const results = await Promise.all(
      ["a", "b"].map((runId) => acquireSyncJobLock(db, { ...input, runId })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const owner = results[0] ? "a" : "b";
    const stale = owner === "a" ? "b" : "a";
    expect(await renewSyncJobLock(db, { ...input, runId: stale })).toBe(false);
    await releaseSyncJobLock(db, input.lockRowId, stale);
    expect(await acquireSyncJobLock(db, { ...input, runId: stale })).toBe(
      false,
    );
    expect(await renewSyncJobLock(db, { ...input, runId: owner })).toBe(true);
    await releaseSyncJobLock(db, input.lockRowId, owner);
    expect(await acquireSyncJobLock(db, { ...input, runId: stale })).toBe(true);
    expect(
      await acquireSyncJobLock(db, {
        ...input,
        lockRowId: "missing",
        runId: owner,
      }),
    ).toBe(false);
  });

  for (const run of [
    {
      name: "einvoice",
      create: createOrGetActiveEinvoiceRun,
      acquire: acquireEinvoiceRunChunkLease,
      renew: renewEinvoiceRunChunkLease,
      release: releaseEinvoiceRunChunkLease,
      complete: completeEinvoiceRun,
      refresh: claimEinvoiceRunSessionRefresh,
    },
    {
      name: "tdcc",
      create: createOrGetActiveTdccRun,
      acquire: acquireTdccRunLease,
      renew: renewTdccRunLease,
      release: releaseTdccRunLease,
      complete: finalizeTdccRun,
      refresh: claimTdccRunSessionRefresh,
    },
  ]) {
    it(`${run.name} 保留 active run conflict、lease 到期邊界與 terminal guard`, async () => {
      const db = harness.binding;
      const created = await run.create(db, {
        id: run.name,
        trigger: "manual",
        now,
      });
      expect(created.created).toBe(true);
      const conflict = await run.create(db, {
        id: "other",
        trigger: "scheduled",
        now,
      });
      expect(conflict.created).toBe(false);
      expect(conflict.run.id).toBe(run.name);
      expect(conflict.run.trigger).toBe("manual");
      const refreshes = await Promise.all(
        [1, 2].map(() => run.refresh(db, { runId: run.name, now })),
      );
      expect(refreshes.filter(Boolean)).toHaveLength(1);
      const input = { runId: run.name, leaseMs: 1000, now: new Date(now) };
      const results = await Promise.all(
        ["a", "b"].map((owner) => run.acquire(db, { ...input, owner })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const owner = results[0] ? "a" : "b";
      const stale = owner === "a" ? "b" : "a";
      expect(await run.renew(db, { ...input, owner: stale })).toBe(false);
      expect(
        await run.release(db, { runId: run.name, owner: stale, now }),
      ).toBe(false);
      expect(await run.renew(db, { ...input, owner })).toBe(true);
      expect(
        await run.acquire(db, {
          ...input,
          owner: stale,
          now: new Date(Date.parse(now) + 1000),
        }),
      ).toBe(false);
      expect(
        await run.acquire(db, {
          ...input,
          owner: stale,
          now: new Date(Date.parse(now) + 1001),
        }),
      ).toBe(true);
      expect(await run.release(db, { runId: run.name, owner, now })).toBe(
        false,
      );
      expect(
        await run.complete(db, { runId: run.name, status: "completed", now }),
      ).toBe(true);
      expect(
        await run.acquire(db, {
          ...input,
          owner,
          now: new Date(Date.parse(now) + 5000),
        }),
      ).toBe(false);
      expect(await run.renew(db, { ...input, owner: stale })).toBe(false);
      expect(
        await run.complete(db, { runId: run.name, status: "failed", now }),
      ).toBe(false);
    });
  }

  it("Drizzle 更新失敗不洩漏 session 參數或底層 cause", async () => {
    const db = harness.binding;
    await createOrGetActiveTdccRun(db, { id: "tdcc", trigger: "manual", now });
    await db
      .prepare(
        `CREATE TRIGGER fail_run_update BEFORE UPDATE ON tdcc_sync_runs BEGIN SELECT RAISE(ABORT, 'synthetic-secret'); END`,
      )
      .run();
    const error = await updateTdccRunState(db, {
      runId: "tdcc",
      encryptedSession: "synthetic-secret",
      now,
    }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Database query failed.");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  });

  it("promotion 中途失敗回滾前置寫入，重試保留 count offset、cursor、finalize 與 cleanup", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('tdcc', 'tdcc', 'synthetic', 'old', ?, ?)`,
      )
      .bind(now, now)
      .run();
    await stageSyncWriteRecords(db, "staged", [
      {
        entityType: "invoice",
        recordKey: "invoice",
        payload: {
          id: "invoice",
          connector_id: "einvoice",
          source_id: "source",
          invoice_number: "AB12345678",
          invoice_date: "2026-09-13",
          seller_name: "Synthetic",
          amount: 100,
          raw_payload: "{}",
          created_at: now,
          updated_at: now,
        },
      },
    ]);
    const before = db.prepare(
      "UPDATE connector_settings SET public_config = '{}' WHERE connector_id = 'tdcc'",
    );
    const cursor = connectorCursorStatement(db, "tdcc", "new", now);
    await expect(
      promoteStagedSyncWrite(db, {
        runId: "staged",
        entityTypes: ["invoice"],
        beforePromoteStatements: [before],
        afterPromoteStatements: [
          db.prepare(
            "INSERT INTO connector_settings SELECT * FROM connector_settings WHERE connector_id = 'tdcc'",
          ),
        ],
        finalizeStatements: [cursor],
      }),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM invoices").first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM sync_write_staging")
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT public_config, sync_cursor FROM connector_settings WHERE connector_id = 'tdcc'",
        )
        .first(),
    ).toEqual({ public_config: null, sync_cursor: "old" });
    const counts = await promoteStagedSyncWrite(db, {
      runId: "staged",
      entityTypes: ["invoice"],
      beforePromoteStatements: [before],
      finalizeStatements: [cursor],
    });
    expect(counts).toMatchObject({
      invoices: 1,
      bankTransactions: 0,
      investmentTransactions: 0,
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM sync_write_staging")
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT public_config, sync_cursor FROM connector_settings WHERE connector_id = 'tdcc'",
        )
        .first(),
    ).toEqual({ public_config: "{}", sync_cursor: "new" });
  });
});
