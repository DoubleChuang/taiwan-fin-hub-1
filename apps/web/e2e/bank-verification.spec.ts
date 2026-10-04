import { expect, test } from "@playwright/test";

test("銀行手動驗證失敗可重試，送出驗證碼後完成同步", async ({ page }) => {
  const job = {
    id: "nextbank:all",
    connectorId: "nextbank",
    scope: "all",
    configured: true,
    enabled: false,
    running: false,
    scheduleMode: "custom",
    intervalMinutes: 10080,
    preferredTime: "06:00",
    preferredWeekday: 1,
    preferredWeekdays: [1],
    lastStatus: "failed",
    lastError: "將來銀行 API：transport",
    lastRunAt: "2026-09-28T01:05:00Z",
    lastSuccessAt: "2026-09-27T01:05:00Z",
  };
  let recover = false;
  let syncCalls = 0;
  let verified = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/connectors/nextbank/sync") {
      syncCalls++;
      if (request.postDataJSON()?.captcha === "A1234") {
        verified = true;
        return route.fulfill({
          json: { success: true, records: 1, cursorUpdated: true },
        });
      }
      return route.fulfill({
        status: 400,
        json: {
          error: {
            code: "NEXTBANK_CAPTCHA_REQUIRED",
            message: "請重新取得圖片。",
          },
        },
      });
    }
    if (path === "/api/connectors/nextbank/captcha") {
      if (!recover)
        return route.fulfill({
          status: 502,
          json: {
            error: {
              code: "TEST_TRANSPORT",
              message: "將來銀行 API：transport",
            },
          },
        });
      return route.fulfill({
        json: {
          captchaImage:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          captchaLength: 5,
          captchaKind: "alphanumeric",
        },
      });
    }
    const data =
      path === "/api/runtime"
        ? { demoMode: false }
        : path === "/api/bank"
          ? { accounts: [], transactions: [] }
          : path === "/api/sync-jobs"
            ? [job]
            : path.endsWith("/settings")
              ? {
                  configured: true,
                  credentialsComplete: true,
                  sessionAvailable: false,
                }
              : path === "/api/sync-schedule"
                ? {
                    intervalMinutes: 10080,
                    preferredTime: "06:00",
                    preferredWeekday: 1,
                    preferredWeekdays: [1],
                  }
                : path === "/api/notifications/config"
                  ? { enabled: false }
                  : [];
    await route.fulfill({ json: data });
  });
  await page.goto("/#/data-sources");
  await page.getByRole("button", { name: "管理將來銀行", exact: true }).click();
  await page.getByRole("button", { name: "改用手動驗證", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("無法取得驗證碼");
  await expect(page.getByRole("alert")).toContainText(
    "手動驗證無法解決連線問題",
  );
  recover = true;
  await page.getByRole("button", { name: "同步帳戶", exact: true }).click();
  await expect(page.getByRole("img", { name: "將來圖形驗證碼" })).toBeVisible();
  const submit = page.getByRole("button", { name: "驗證並同步", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByRole("textbox", { name: /驗證碼/ }).fill("A1234");
  await submit.click();
  await expect(
    page.getByRole("status").filter({ hasText: "同步成功，帳戶資料已更新" }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: "將來圖形驗證碼" })).toHaveCount(
    0,
  );
  expect(verified).toBe(true);
  expect(syncCalls).toBe(2);
});
