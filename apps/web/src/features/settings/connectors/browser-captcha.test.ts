import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/shared/api/client";
import { browserCaptchaFailure } from "./browser-captcha";

describe("browserCaptchaFailure", () => {
  it("invalidates a CAPTCHA image after the server closes its browser session", () => {
    expect(
      browserCaptchaFailure(
        new ApiRequestError("USER_ACTION_REQUIRED", "圖形驗證碼錯誤。", 400),
      ),
    ).toEqual({
      message: "圖形驗證碼錯誤。 請重新取得驗證碼。",
      sessionInvalidated: true,
    });
  });

  it("keeps the current image for local validation errors", () => {
    expect(browserCaptchaFailure(new Error("請輸入 6 位數字驗證碼。"))).toEqual(
      {
        message: "請輸入 6 位數字驗證碼。",
        sessionInvalidated: false,
      },
    );
  });

  it("clears a rejected O-Bank API CAPTCHA session", () => {
    expect(
      browserCaptchaFailure(
        new ApiRequestError(
          "OBANK_CONNECTION_FAILED",
          "王道銀行服務回應格式已變更。",
          502,
        ),
      ),
    ).toEqual({
      message: "王道銀行服務回應格式已變更。 請重新取得驗證碼。",
      sessionInvalidated: true,
    });
  });

  it("clears a rejected Mega Bank API CAPTCHA session", () => {
    expect(
      browserCaptchaFailure(
        new ApiRequestError(
          "MEGABANK_CONNECTION_FAILED",
          "兆豐銀行查詢失敗。",
          502,
        ),
      ),
    ).toEqual({
      message: "兆豐銀行查詢失敗。 請重新取得驗證碼。",
      sessionInvalidated: true,
    });
  });

  it("invalidates a First Bank CAPTCHA session after a browser failure", () => {
    const message = "第一銀行瀏覽器工作階段已失效。";
    expect(
      browserCaptchaFailure(
        new ApiRequestError("FIRSTBANK_CONNECTION_FAILED", message, 502),
      ),
    ).toEqual({
      message: `${message} 請重新取得驗證碼。`,
      sessionInvalidated: true,
    });
  });

  it("keeps the current image when First Bank card parsing fails after login", () => {
    const message = "第一銀行連線失敗：第一銀行信用卡交易欄位格式已變更。";
    expect(
      browserCaptchaFailure(
        new ApiRequestError("FIRSTBANK_CONNECTION_FAILED", message, 502),
      ),
    ).toEqual({
      message,
      sessionInvalidated: false,
    });
  });

  it("shows the Browser Run daily reset message without a CAPTCHA instruction", () => {
    const message =
      "Cloudflare 瀏覽器今日使用額度已用完。額度每日台灣時間早上 8 點重置，請於重置後再試。";
    expect(
      browserCaptchaFailure(new ApiRequestError("BROWSER_BUSY", message, 429)),
    ).toEqual({
      message,
      sessionInvalidated: false,
    });
  });
});
