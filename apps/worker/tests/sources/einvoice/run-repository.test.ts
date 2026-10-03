import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  createOrGetActiveEinvoiceRun,
  getEinvoiceRun,
  mergeEinvoiceRunItems,
  promoteEinvoiceRunRecords,
} from "../../../src/sources/einvoice/run-repository";

const version = "2026-09-01T00:00:00Z";
const promotedAt = "2026-09-02T00:00:00Z";

describe("發票分段同步的正式資料（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await db.batch([
      ...[
        "invoice_line_items",
        "invoices",
        "einvoice_sync_run_items",
        "einvoice_sync_runs",
        "connector_settings",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
      db
        .prepare(
          "INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('einvoice', 'einvoice', 'synthetic-encrypted', 'old', ?, ?)",
        )
        .bind(version, version),
    ]);
  });
  async function prepareRun(done = true) {
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run",
      trigger: "manual",
      now: version,
    });
    await mergeEinvoiceRunItems(
      db,
      run.id,
      [
        {
          invoiceSourceId: "invoice-1",
          header: { invoiceNumber: "AB12345678" },
          normalizedInvoice: {
            sourceId: "invoice-1",
            invoiceNumber: "AB12345678",
            invoiceDate: "2026-09-01",
            sellerName: "測試商店",
            amount: 120,
          },
          detailKey: "detail-1",
          ...(done
            ? {
                detailItems: [
                  {
                    invoiceSourceId: "invoice-1",
                    sourceId: "line-1",
                    lineNumber: 1,
                    description: "測試品項",
                    quantity: 2,
                    unitPrice: 60,
                    amount: 120,
                  },
                ],
              }
            : {}),
        },
      ],
      version,
    );
    await db
      .prepare(
        "UPDATE einvoice_sync_runs SET status = 'processing', settings_version = ? WHERE id = ?",
      )
      .bind(version, run.id)
      .run();
    return run;
  }
  async function snapshot() {
    return Promise.all(
      [
        "einvoice_sync_runs",
        "connector_settings",
        "invoices",
        "invoice_line_items",
      ].map(
        async (table) =>
          (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
            .results,
      ),
    );
  }

  it("完整發票與品項一起寫入，重送不重複資料或推進 cursor", async () => {
    const run = await prepareRun();
    expect(
      await promoteEinvoiceRunRecords(db, {
        runId: run.id,
        expectedSettingsUpdatedAt: version,
        cursor: "new",
        now: promotedAt,
      }),
    ).toBe(true);
    expect(
      (
        await db
          .prepare("SELECT id, source_id, invoice_number, amount FROM invoices")
          .all()
      ).results,
    ).toEqual([
      {
        id: "einvoice:invoice-1",
        source_id: "invoice-1",
        invoice_number: "AB12345678",
        amount: 120,
      },
    ]);
    expect(
      (
        await db
          .prepare(
            "SELECT invoice_id, quantity, unit_price, amount FROM invoice_line_items",
          )
          .all()
      ).results,
    ).toEqual([
      {
        invoice_id: "einvoice:invoice-1",
        quantity: 2,
        unit_price: 60,
        amount: 120,
      },
    ]);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      new_invoice_count: 1,
      promoted_at: promotedAt,
    });
    expect(
      await db
        .prepare("SELECT sync_cursor, updated_at FROM connector_settings")
        .first(),
    ).toEqual({ sync_cursor: "new", updated_at: promotedAt });
    const after = await snapshot();
    expect(
      await promoteEinvoiceRunRecords(db, {
        runId: run.id,
        expectedSettingsUpdatedAt: promotedAt,
        cursor: "replay",
        now: "2026-09-03T00:00:00Z",
      }),
    ).toBe(false);
    expect(await snapshot()).toEqual(after);
  });

  it.each(["settings-changed", "incomplete"])(
    "%s 的 run 不會發布部分發票或覆蓋 cursor",
    async (state) => {
      const run = await prepareRun(state !== "incomplete");
      if (state === "settings-changed")
        await db
          .prepare(
            "UPDATE connector_settings SET encrypted_config = 'new-secret', updated_at = 'new-version'",
          )
          .run();
      const before = await snapshot();
      expect(
        await promoteEinvoiceRunRecords(db, {
          runId: run.id,
          expectedSettingsUpdatedAt: version,
          cursor: "stale",
          now: promotedAt,
        }),
      ).toBe(false);
      expect(await snapshot()).toEqual(before);
    },
  );
});
