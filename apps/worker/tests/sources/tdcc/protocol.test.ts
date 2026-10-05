import { describe, expect, it } from "vitest";
import {
  normalizeTdccBankAuthorizedAt,
  parseTdccConfig,
  parseTdccTradePageItems,
} from "../../../src/sources/tdcc/protocol";

describe("TDCC 銀行授權時間正規化", () => {
  it.each([
    ["2026-07-01T00:00:00", "2026-07-01T00:00:00+08:00"],
    ["1970-01-01T00:00:00", "1970-01-01"],
    ["2026-07-01", "2026-07-01"],
  ])("normalizeTdccBankAuthorizedAt(%s) -> %s", (input, expected) => {
    expect(normalizeTdccBankAuthorizedAt(input)).toBe(expected);
  });
});

describe("TDCC TR002 交易頁解析", () => {
  const account = {
    brokerNo: "9A92",
    brokerAccount: "1234567",
    brokerName: "Test Broker",
  };

  it("保留 sourceId 與數量乘價格的金額", () => {
    const rows = parseTdccTradePageItems(
      {
        items: [
          [
            "20240615",
            "TXN-1",
            "2330",
            "TSMC",
            "TW",
            "",
            "11",
            "",
            "11",
            "20240614",
            "B",
            "買進",
            "2",
            "",
            "",
            "",
            "",
            "",
            "500",
            "20240615",
            "TWD",
          ],
        ],
      },
      account,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceId).toBe("2024061420240615TXN-1");
    expect(rows[0]?.amount).toBe(1000);
    expect(rows[0]?.symbol).toBe("2330");
    expect(rows[0]?.assetType).toBe("stock");
  });
});

describe("TDCC 設定解析", () => {
  it("套用 OTP 與交易頁數預設值", () => {
    const config = parseTdccConfig({
      userId: "A123456789",
      password: "secret",
    });
    expect(config.requestOtp).toBe(true);
    expect(config.tradeHistoryMaxPages).toBe(20);
    expect(config.holdings).toEqual([]);
  });

  it("保留使用者提供的 OTP 與關閉 OTP 請求設定", () => {
    const config = parseTdccConfig({
      userId: "A123456789",
      password: "secret",
      otp: "123456",
      requestOtp: false,
    });
    expect(config.otp).toBe("123456");
    expect(config.requestOtp).toBe(false);
  });
});
