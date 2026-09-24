import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import InstitutionDetails from "./InstitutionDetails.svelte";
import { calculateAssetSummary } from "../model/summary";

describe("credit card balance availability", () => {
  it.each([null, undefined, 0, -1200])(
    "distinguishes missing balances from a confirmed balance of %s",
    (balance) => {
      const summary = calculateAssetSummary({
        bank: {
          accounts: [
            {
              id: "yen",
              sourceId: "yen",
              connectorId: "sinopac",
              accountType: "credit",
              currency: "JPY",
              balance,
            },
          ],
          transactions: [],
        },
        investments: [],
        manualAssets: [],
        rates: [{ currency: "JPY", rateTwd: 0.2, updatedAt: "2026-09-13" }],
      });
      expect(summary.hasUnknownCardBalance).toBe(balance == null);
      expect(summary.institutionGroups[0].hasUnknownCardBalance).toBe(
        balance == null,
      );
      render(InstitutionDetails, {
        group: summary.institutionGroups[0],
        bills: [],
      });
      if (balance == null) {
        expect(screen.getByText("金額尚未取得")).toBeInTheDocument();
        expect(screen.getByText("資料不完整")).toBeInTheDocument();
        expect(screen.queryByText("JP¥0")).not.toBeInTheDocument();
      } else {
        expect(screen.queryByText("金額尚未取得")).not.toBeInTheDocument();
        expect(screen.queryByText("資料不完整")).not.toBeInTheDocument();
        expect(
          screen.getByText(balance === 0 ? "JP¥0" : "−JP¥1,200"),
        ).toBeInTheDocument();
      }
    },
  );
});
