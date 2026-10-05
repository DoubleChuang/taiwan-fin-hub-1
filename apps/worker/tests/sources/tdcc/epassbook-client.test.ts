import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EPassbookClient,
  EPassbookError,
  normalizeBankTransactionDetails,
} from "../../../src/sources/tdcc/epassbook-client";

describe("TDCC 銀行交易識別碼正規化", () => {
  it("空白 STAN 與空白差異的 memo 仍產生相同且穩定的 txnId", () => {
    const details = [
      {
        stan: " ",
        txnDateTime: "20260821000000",
        transferInAmount: "102.0",
        transferOutAmount: "0.0",
        memo: "利息 102稅額 0健保費 0",
      },
      {
        stan: "",
        txnDateTime: "20260821000000",
        transferInAmount: "102.0",
        transferOutAmount: "0.0",
        memo: "利息102稅額0健保費0",
      },
    ];
    const normalized = normalizeBankTransactionDetails(details);
    expect(normalized[0]?.txnId).toBeTruthy();
    expect(normalized[0]?.txnId).toBe(normalized[1]?.txnId);
    expect(normalizeBankTransactionDetails(details)).toEqual(normalized);
  });

  it("交易之後才補上 STAN 不會改變 txnId", () => {
    const detail = {
      txnDateTime: "20260821000000",
      transferInAmount: "102.0",
      transferOutAmount: "0.0",
      memo: "Interest payment",
    };
    const withoutStan = normalizeBankTransactionDetails([detail])[0];
    expect(withoutStan?.txnId).toBe(
      "missing:2026-08-21T00:00:00:102:Interestpayment",
    );
    expect(
      normalizeBankTransactionDetails([{ ...detail, stan: "00000" }])[0]?.txnId,
    ).toBe(withoutStan?.txnId);
  });

  it("錯誤日期固定為 1970-01-01 而非使用 wall-clock", () => {
    const malformed = [
      { stan: "", txnDateTime: "invalid", transferInAmount: "1" },
    ];
    const first = normalizeBankTransactionDetails(malformed)[0];
    expect(first?.occurredAt).toBe("1970-01-01T00:00:00");
    expect(first?.txnId).toBe("missing:1970-01-01T00:00:00:1:-");
    expect(normalizeBankTransactionDetails(malformed)).toEqual(
      normalizeBankTransactionDetails(malformed),
    );
  });
});

function jsonResponse(responseBody: unknown, returnCode = "0000") {
  return new Response(
    JSON.stringify({
      responseHeader: { returnCode, tokenID: "TKN-1" },
      responseBody,
    }),
    { status: 200 },
  );
}

function stubTsp007Fetch(
  responseBody: (requestBody: { pageToken?: string }) => unknown,
) {
  const calls: string[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = input.toString().split("/rest/")[1] ?? "";
      calls.push(endpoint);
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        requestBody?: { pageToken?: string };
      };
      return jsonResponse(responseBody(request.requestBody ?? {}));
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function createPageClient() {
  return new EPassbookClient({
    devId: "dev-page",
    devType: "Android:14",
    devModel: "SM-G991B",
    session: { tokenId: "TKN-1", richUrl: null },
  });
}

describe("TDCC TSP007 單頁契約", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("回傳當頁游標、下一頁游標、總筆數與正規化交易", async () => {
    const calls = stubTsp007Fetch(() => ({
      transactionDetails: [
        {
          stan: "live-cash-move-1",
          txnDateTime: "20240614120000",
          transferInAmount: "1000",
          transferOutAmount: "0",
          summary: "Settlement credit",
        },
      ],
      pageToken: "NEXT-1",
      totalCount: 2,
    }));
    const firstPage = await createPageClient().getBankTransactionsPage(
      "004",
      "1234567890",
      "TWD",
      "",
    );
    expect(calls).toEqual(["tsp/TSP007"]);
    expect(firstPage.pageToken).toBe("");
    expect(firstPage.pageRecordCount).toBe(1);
    expect(firstPage.totalCount).toBe(2);
    expect(firstPage.nextPageToken).toBe("NEXT-1");
    expect(firstPage.transactions[0]?.txnId).toBe(
      "missing:2024-06-14T12:00:00:1000:Settlementcredit",
    );
  });

  it("最後一頁沒有 pageToken 時不帶 nextPageToken", async () => {
    stubTsp007Fetch(() => ({
      transactionDetails: [
        {
          stan: "live-cash-move-2",
          txnDateTime: "20240615130000",
          transferInAmount: "0",
          transferOutAmount: "250",
          memo: "Settlement debit",
        },
      ],
      pageToken: "",
      totalCount: 2,
    }));
    const page = await createPageClient().getBankTransactionsPage(
      "004",
      "1234567890",
      "TWD",
      "NEXT-1",
    );
    expect(page.pageRecordCount).toBe(1);
    expect(page.nextPageToken).toBeUndefined();
    expect(page.transactions[0]?.amount).toBe("-250");
  });

  it("pageToken 原地重複時丟出 PAGINATION_LOOP", async () => {
    stubTsp007Fetch(() => ({
      transactionDetails: [],
      pageToken: "LOOP",
      totalCount: 1,
    }));
    const page = createPageClient().getBankTransactionsPage(
      "004",
      "1234567890",
      "TWD",
      "LOOP",
    );
    await expect(page).rejects.toThrow(EPassbookError);
    await expect(page).rejects.toMatchObject({ code: "PAGINATION_LOOP" });
  });
});
