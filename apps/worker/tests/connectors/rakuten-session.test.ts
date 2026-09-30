import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import { BrowserRunCapacityError } from "../../src/connectors/browser";
import {
  classifyRakutenLoginText,
  createRakutenConnector,
  dataUriToBuffer,
  installRakutenResponseTap,
  normalizeRakutenCaptchaAnswer,
  prepareRakutenCaptcha,
  RakutenAutoCaptchaFailedError,
  RakutenBrowserCapacityError,
  RakutenCaptchaRecognizerError,
  RakutenCaptchaRejectedError,
  RakutenConnectionError,
  RakutenCredentialRejectedError,
  RakutenDeviceBindingRequiredError,
  RakutenSessionConflictError,
  RakutenVerificationRequiredError,
  runRakutenOcrAttempts,
} from "../../src/connectors/rakuten";

const LOGIN_URL = "https://www.rakuten-bank.com.tw/ebank/cgn/cgnot0001/010";
const HOME_URL = "https://www.rakuten-bank.com.tw/ebank/chm/chmqu0001/010";
const TWD_DEPOSIT_URL =
  "https://www.rakuten-bank.com.tw/ebank/ctw/ctwqu0001/010";

const credentials = {
  userId: "A123456789",
  account: "rakuten-user",
  password: "testpass12",
};

const depositPageText = `
臺幣存款
活存

活存總額 0081200000001234
$52,345
`;

/** 網頁自己解密後的首頁（CHMQU0001）回應內容。 */
const DEFAULT_DASHBOARD_RS_DATA = {
  depositInfo: {
    depAccounts: [
      {
        acctNo: "0081200000001234",
        showAcctNo: "008-***-1234",
        ntdCurrBal: 52345,
      },
    ],
  },
};

type PageState = {
  navClicks?: Array<{ exact?: string }>;
  sessionExpired?: boolean;
  currentUrl: string;
  captchaDataUri?: string;
  modalText?: string;
  modalTexts?: string[];
  depositText?: string;
  loginClicked: number;
  onLoginClick?: (attempt: number) => void;
  /** 解密後的首頁資料；null 表示網頁沒有送出／攔截不到。 */
  tapDashboard?: unknown;
  logoutClicked?: boolean;
  logoutConfirmed?: boolean;
};

function makePage(overrides?: Partial<PageState>) {
  const state: PageState = {
    currentUrl: LOGIN_URL,
    captchaDataUri: "data:image/png;base64,AQID",
    loginClicked: 0,
    tapDashboard: DEFAULT_DASHBOARD_RS_DATA,
    ...overrides,
  };

  const bodyTextForCurrentUrl = () => {
    if (state.currentUrl.includes("ctwqu0001")) return state.depositText ?? "";
    return "";
  };

  const evaluate = vi
    .fn()
    .mockImplementation(
      async (fn: (...args: never[]) => unknown, arg?: unknown) => {
        const source = String(fn);
        if (source.includes("__tfhRakutenTap")) {
          // 讀取頁面內攔截到的解密後回應（依網頁送出順序排列）
          if (state.sessionExpired && state.currentUrl !== LOGIN_URL) {
            state.currentUrl = LOGIN_URL;
          }
          if (state.currentUrl === LOGIN_URL) return { count: 0, rsData: null };
          const input = (arg ?? {}) as {
            suffix?: string;
            afterIndex?: number;
          };
          const entries: Array<{ path: string; rsData: unknown }> = [];
          if (state.tapDashboard != null) {
            entries.push({ path: "CHMQU0001", rsData: state.tapDashboard });
          }
          const suffix = String(input.suffix ?? "");
          const afterIndex = input.afterIndex ?? 0;
          for (let i = entries.length - 1; i >= afterIndex; i -= 1) {
            if (!suffix.includes(entries[i]!.path)) continue;
            return { count: entries.length, rsData: entries[i]!.rsData };
          }
          return { count: entries.length, rsData: null };
        }
        if (source.includes("確認登出")) {
          if (!state.logoutClicked) return "no_modal";
          state.logoutConfirmed = true;
          state.currentUrl = LOGIN_URL;
          return "clicked";
        }
        if (source.includes("captcha-image")) {
          return state.captchaDataUri ?? "";
        }
        if (source.includes("modal-title")) {
          if (state.loginClicked === 0) {
            return /維護/.test(state.modalText ?? "")
              ? (state.modalText ?? "")
              : "";
          }
          if (state.modalTexts && state.modalTexts.length > 0) {
            return state.modalTexts.shift() ?? "";
          }
          return state.modalText ?? "";
        }
        if (source.includes("btn-primary")) {
          state.loginClicked += 1;
          state.onLoginClick?.(state.loginClicked);
          return undefined;
        }
        if (source.includes("rakuten-nav-click")) {
          // SPA 選單點擊：依使用者操作路徑切頁，不整頁重載。
          const spec = (arg ?? {}) as { exact?: string };
          state.navClicks = [...(state.navClicks ?? []), spec];
          // 已被導回登入頁時，選單連結都不存在
          if (state.currentUrl === LOGIN_URL) return false;
          if (spec.exact === "登出") {
            state.logoutClicked = true;
            return true;
          }
          if (spec.exact === "臺幣存款" || spec.exact === "存款") {
            state.currentUrl = TWD_DEPOSIT_URL;
            return true;
          }
          return false;
        }
        if (source.includes("innerText")) {
          return bodyTextForCurrentUrl();
        }
        if (source.includes("focus")) {
          return undefined;
        }
        return undefined;
      },
    );

  return {
    state,
    evaluate,
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockImplementation(async (url: string) => {
      state.currentUrl = url;
      state.loginClicked = 0;
      return { status: () => 200 };
    }),
    on: vi.fn(),
    off: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => state.currentUrl),
    waitForFunction: vi
      .fn()
      .mockImplementation(async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("custNo")) return undefined;
        if (source.includes("captcha-image")) {
          if (!state.captchaDataUri) {
            throw new Error(
              "waiting for function failed: timeout 10000ms exceeded",
            );
          }
          return undefined;
        }
        return undefined;
      }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };
}

function browser(browserPage: ReturnType<typeof makePage>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockResolvedValue([browserPage]),
    newPage: vi.fn().mockResolvedValue(browserPage),
    sessionId: vi.fn().mockReturnValue("rakuten-session"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  puppeteerMock.sessions.mockResolvedValue([]);
  puppeteerMock.limits.mockResolvedValue({
    activeSessions: [],
    maxConcurrentSessions: 3,
    allowedBrowserAcquisitions: 1,
    timeUntilNextAllowedBrowserAcquisition: 0,
  });
});

describe("Rakuten CAPTCHA preparation", () => {
  it("launches a browser, fills the login form, captures the CAPTCHA data URI, and preserves the session", async () => {
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const result = await prepareRakutenCaptcha({} as Fetcher, credentials);

    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(browserPage.goto).toHaveBeenCalledWith(
      LOGIN_URL,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(browserPage.type).toHaveBeenCalledWith(
      "#custNo",
      credentials.userId,
      expect.any(Object),
    );
    expect(browserPage.type).toHaveBeenCalledWith(
      "#userNo",
      credentials.account,
      expect.any(Object),
    );
    expect(browserPage.type).toHaveBeenCalledWith(
      "#pcode",
      credentials.password,
      expect.any(Object),
    );
    expect(browserInstance.sessionId).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).toHaveBeenCalledOnce();
    expect(browserInstance.close).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      browserSessionId: "rakuten-session",
      captchaLength: 4,
      captchaImage: "data:image/png;base64,AQID",
    });
  });

  it("accepts alerts but dismisses confirms, logging only the dialog shape", async () => {
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await prepareRakutenCaptcha({} as Fetcher, credentials);

      const dialogHandler = browserPage.on.mock.calls.find(
        ([event]) => event === "dialog",
      )?.[1] as ((dialog: unknown) => void) | undefined;
      expect(dialogHandler).toBeTypeOf("function");
      const dialog = (type: string, message: string) => ({
        type: () => type,
        message: () => message,
        accept: vi.fn().mockResolvedValue(undefined),
        dismiss: vi.fn().mockResolvedValue(undefined),
      });

      const alert = dialog("alert", "測試客戶 您好，系統將於今晚維護");
      dialogHandler?.(alert);
      expect(alert.accept).toHaveBeenCalledOnce();
      expect(alert.dismiss).not.toHaveBeenCalled();

      const confirm = dialog("confirm", "您已在其他裝置登入，是否繼續登入？");
      dialogHandler?.(confirm);
      expect(confirm.dismiss).toHaveBeenCalledOnce();
      expect(confirm.accept).not.toHaveBeenCalled();

      const logged = [...log.mock.calls, ...warn.mock.calls].map(([value]) =>
        String(value),
      );
      expect(logged.join("\n")).not.toContain("測試客戶");
      expect(logged.join("\n")).not.toContain("其他裝置");
      expect(
        log.mock.calls.map(([value]) => JSON.parse(String(value))),
      ).toContainEqual({
        event: "rakuten_dialog_handled",
        type: "alert",
        action: "accepted",
        category: "maintenance",
        messageLength: 16,
      });
      expect(
        warn.mock.calls.map(([value]) => JSON.parse(String(value))),
      ).toContainEqual({
        event: "rakuten_dialog_handled",
        type: "confirm",
        action: "dismissed",
        category: "session_conflict",
        messageLength: 17,
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("reuses a pending CAPTCHA browser instead of launching another one", async () => {
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await prepareRakutenCaptcha({} as Fetcher, {
      ...credentials,
      browserSessionId: "rakuten-session",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "rakuten-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(result.browserSessionId).toBe("rakuten-session");
  });

  it("does not launch when the pending CAPTCHA browser is still connected", async () => {
    puppeteerMock.sessions.mockResolvedValue([
      {
        sessionId: "rakuten-session",
        startTime: Date.now(),
        connectionId: "busy-connection",
      },
    ]);

    await expect(
      prepareRakutenCaptcha({} as Fetcher, {
        ...credentials,
        browserSessionId: "rakuten-session",
      }),
    ).rejects.toBeInstanceOf(RakutenBrowserCapacityError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });
});

describe("Rakuten sync without OCR callback or when manual session is invalid", () => {
  it("rejects without touching the browser when no captcha or session id is present", async () => {
    await expect(
      createRakutenConnector({} as Fetcher).sync({ ...credentials }),
    ).rejects.toBeInstanceOf(RakutenVerificationRequiredError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
    expect(puppeteerMock.sessions).not.toHaveBeenCalled();
  });

  it("rejects without touching the browser when a session id exists but no captcha was typed", async () => {
    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
      }),
    ).rejects.toBeInstanceOf(RakutenVerificationRequiredError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
  });

  it("rejects an expired CAPTCHA session without reconnecting to the browser", async () => {
    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenVerificationRequiredError);
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
  });

  it("accepts a recognizeCaptcha-style callback as the second argument", () => {
    expect(createRakutenConnector.length).toBe(2);
  });
});

describe("Rakuten automated OCR login", () => {
  it("automatically launches browser, recognizes CAPTCHA, logs in and parses data on first attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "36CY",
      expect.any(Object),
    );
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("retries up to 3 times on CAPTCHA error, succeeding on second attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clickCount = 0;
    const browserPage = makePage({
      modalText: "驗證碼錯誤",
      depositText: depositPageText,
      onLoginClick: () => {
        clickCount += 1;
        if (clickCount >= 2) {
          browserPage.state.currentUrl = HOME_URL;
        }
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("WRNG")
      .mockResolvedValueOnce("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(browserPage.goto).toHaveBeenCalledTimes(2);
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("fails after 3 consecutive CAPTCHA rejections and closes browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      modalText: "驗證碼錯誤",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("WRNG");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toThrow("連續失敗 3 次");

    expect(recognize).toHaveBeenCalledTimes(3);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stops immediately on credential rejection without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      modalText: "使用者代號或密碼錯誤",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stops immediately on session conflict without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      modalText: "重複登入",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenSessionConflictError);

    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("prioritizes manual verification and skips OCR when browserSessionId and captcha are provided", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("9999");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledOnce();
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("Rakuten Browser Run capacity", () => {
  it("reports the shared acquisition rate limit without launching a browser", async () => {
    puppeteerMock.limits.mockResolvedValue({
      activeSessions: [],
      maxConcurrentSessions: 3,
      allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 8_000,
    });

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toMatchObject({
      name: "BrowserRunCapacityError",
      kind: "acquisition_rate_limit",
      retryAfterSeconds: 8,
    });
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });

  it("classifies a daily quota failure from the browser launch", async () => {
    puppeteerMock.launch.mockRejectedValue(
      new Error("Browser time limit exceeded for today"),
    );

    const error = await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    )
      .sync(credentials)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserRunCapacityError);
    expect(error).toMatchObject({ kind: "daily_quota" });
  });
});

describe("Rakuten browser session lifecycle", () => {
  it("submits the prepared CAPTCHA, logs in, and parses the deposit data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => undefined,
    });
    browserPage.state.onLoginClick = () => {
      browserPage.state.currentUrl = HOME_URL;
    };
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await createRakutenConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "rakuten-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "36CY",
      expect.any(Object),
    );
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(result.bankBalanceSnapshots?.length).toBeGreaterThan(0);
    expect(result.cursor).toBeUndefined();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
  });

  it("reports a lost session when the bank sends the page back to login", async () => {
    const browserPage = makePage({
      sessionExpired: true,
    });
    browserPage.state.onLoginClick = () => {
      browserPage.state.currentUrl = HOME_URL;
    };
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toThrow("樂天網銀 session 已失效，請重新登入。");
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("classifies a multi-device login modal as a session conflict and never clicks a takeover button", async () => {
    const browserPage = makePage({
      modalText:
        "帳號重複登入\n您已在其他裝置登入，繼續登入將會登出前一個裝置，是否以此裝置登入？",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenSessionConflictError);

    const loginClicks = browserPage.evaluate.mock.calls.filter(([fn]) =>
      String(fn).includes("btn-primary"),
    );
    expect(loginClicks).toHaveLength(1);
  });

  it("classifies a captcha error modal as a captcha rejection", async () => {
    const browserPage = makePage({ modalText: "驗證碼錯誤，請重新輸入" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenCaptchaRejectedError);
  });

  it("classifies a credential error modal as a credential rejection", async () => {
    const browserPage = makePage({ modalText: "使用者代號或密碼錯誤" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);
  });

  it("classifies a maintenance modal as a temporary connection error", async () => {
    const browserPage = makePage({ modalText: "系統維護中，暫時停止服務。" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenConnectionError);
  });

  it("classifies a device-binding prompt as needing manual handling", async () => {
    const browserPage = makePage({
      modalText: "本次登入需要進行裝置綁定（晶片金融卡）",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenDeviceBindingRequiredError);
  });

  it("classifies an SMS verification prompt as device verification, not a captcha error", async () => {
    const browserPage = makePage({
      modalText: "驗證手機號碼\n請輸入簡訊驗證碼以完成本裝置驗證",
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenDeviceBindingRequiredError);
  });

  it("treats an unresolved login result as a connection error and masks long digit runs in the log", async () => {
    vi.useFakeTimers();
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pending = createRakutenConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });
    // Attach a handler immediately so advancing fake timers below cannot
    // surface this as an unhandled rejection before the assertion runs.
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).rejects.toBeInstanceOf(RakutenConnectionError);

    const events = warn.mock.calls.flatMap(([value]) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        return parsed && typeof parsed === "object" ? [parsed] : [];
      } catch {
        return [];
      }
    }) as Array<Record<string, unknown>>;
    const unresolved = events.find(
      (event) => event.event === "rakuten_login_outcome_unknown",
    );
    expect(unresolved).toBeDefined();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("closes the browser (never disconnects) after a rejected sync", async () => {
    const browserPage = makePage({ modalText: "使用者代號或密碼錯誤" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createRakutenConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "rakuten-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "36CY",
      }),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
  });
});

describe("Rakuten OCR login hardening", () => {
  it("normalizes whitespace and punctuation in the OCR answer before typing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi.fn().mockResolvedValue(' "36 CY".\n');

    await createRakutenConnector({} as Fetcher, recognize).sync(credentials);

    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "36CY",
      expect.any(Object),
    );
    warn.mockRestore();
  });

  it("retries with a fresh CAPTCHA when the OCR answer has the wrong length", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("36C")
      .mockResolvedValueOnce("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(browserPage.goto).toHaveBeenCalledTimes(2);
    // 格式不符的答案不應送出登入
    expect(browserPage.state.loginClicked).toBe(1);
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("reports exhausted OCR attempts with a dedicated error carrying the last cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({ modalText: "驗證碼錯誤" });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi.fn().mockResolvedValue("WRNG");

    const error = await createRakutenConnector({} as Fetcher, recognize)
      .sync(credentials)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect(error).toBeInstanceOf(RakutenVerificationRequiredError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("exhausted");
    expect((error as Error).cause).toBeInstanceOf(RakutenCaptchaRejectedError);
    warn.mockRestore();
  });

  it("does not retry when the recognizer service fails, and asks for manual verification", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockRejectedValue(new Error("AI quota exceeded"));

    const error = await createRakutenConnector({} as Fetcher, recognize)
      .sync(credentials)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe(
      "recognizer_unavailable",
    );
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.state.loginClicked).toBe(0);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("times out a hanging recognizer instead of stalling the sync", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockImplementation(() => new Promise(() => {}));

    const pending = createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe(
      "recognizer_unavailable",
    );
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("does not retry an unresolved login outcome in OCR mode (avoids lockout)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    const pending = createRakutenConnector({} as Fetcher, recognize).sync(
      credentials,
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RakutenConnectionError);
    expect(error).not.toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.state.loginClicked).toBe(1);
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("does not classify login-page field labels as a credential error while waiting", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 整頁文字含「身分證字號」「密碼」「驗證碼」等欄位標籤，但沒有錯誤 modal
    const browserPage = makePage({
      depositText: "身分證字號\n使用者代號\n密碼\n圖形驗證碼\n約定條款",
    });
    browserPage.state.currentUrl = TWD_DEPOSIT_URL;
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const pending = createRakutenConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "36CY",
    });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RakutenConnectionError);
    expect(error).not.toBeInstanceOf(RakutenCredentialRejectedError);
    expect(error).not.toBeInstanceOf(RakutenCaptchaRejectedError);
    expect(error).not.toBeInstanceOf(RakutenDeviceBindingRequiredError);
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("recognizes the refreshed CAPTCHA when the image changes after credentials are filled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    browserPage.type.mockImplementation(async (selector: string) => {
      if (selector === "#pcode") {
        browserPage.state.captchaDataUri = "data:image/png;base64,BAUG";
      }
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("OLD1")
      .mockResolvedValueOnce("NEW2");

    await createRakutenConnector({} as Fetcher, recognize).sync(credentials);

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(browserPage.type).toHaveBeenCalledWith(
      "#captcha",
      "NEW2",
      expect.any(Object),
    );
    expect(browserPage.type).not.toHaveBeenCalledWith(
      "#captcha",
      "OLD1",
      expect.any(Object),
    );
    warn.mockRestore();
  });

  it("returns the refreshed CAPTCHA image from prepare when it changes after filling credentials", async () => {
    const browserPage = makePage();
    browserPage.type.mockImplementation(async (selector: string) => {
      if (selector === "#pcode") {
        browserPage.state.captchaDataUri = "data:image/png;base64,BAUG";
      }
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    const result = await prepareRakutenCaptcha({} as Fetcher, credentials);

    expect(result.captchaImage).toBe("data:image/png;base64,BAUG");
  });

  it("falls back to OCR when the manual CAPTCHA expired and releases the stale browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const staleBrowser = browser(makePage());
    const browserPage = makePage({
      depositText: depositPageText,
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const freshBrowser = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "rakuten-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(staleBrowser);
    puppeteerMock.launch.mockResolvedValue(freshBrowser);
    const recognize = vi.fn().mockResolvedValue("36CY");

    const result = await createRakutenConnector({} as Fetcher, recognize).sync({
      ...credentials,
      browserSessionId: "rakuten-session",
      browserSessionExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      captcha: "ABCD",
    });

    expect(staleBrowser.close).toHaveBeenCalledOnce();
    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserPage.type).not.toHaveBeenCalledWith(
      "#captcha",
      "ABCD",
      expect.any(Object),
    );
    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("does not log page text when the parsed result is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: "帳號 0081200000009999 王小明 無法解析",
      // 解密後的首頁資料沒有可用的存款，迫使流程走到文字備援
      tapDashboard: {},
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenConnectionError);

    const logged = [...warn.mock.calls, ...log.mock.calls]
      .map(([value]) => String(value))
      .join("\n");
    expect(logged).toContain("rakuten_sync_empty_result");
    expect(logged).not.toContain("0081200000009999");
    expect(logged).not.toContain("王小明");
    warn.mockRestore();
    log.mockRestore();
  }, 15_000);
});

describe("Rakuten log levels and sync summary", () => {
  function parsedEvents(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.flatMap(([value]) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        return parsed && typeof parsed === "object"
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }

  it("logs one info-level summary for a successful sync and no warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    expect(warn).not.toHaveBeenCalled();
    const summaries = parsedEvents(log).filter(
      (event) => event.event === "rakuten_sync_summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      event: "rakuten_sync_summary",
      outcome: "success",
      loginMode: "ocr",
      ocrAttempts: 1,
      depositSource: "tap",
      depositAccountCount: 1,
      durationMs: expect.any(Number),
    });
    warn.mockRestore();
    log.mockRestore();
  });

  it("summarizes a failed sync with the error name, stage and OCR attempts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let clicks = 0;
    const browserPage = makePage({
      modalTexts: ["驗證碼錯誤", "使用者代號或密碼錯誤"],
      onLoginClick: () => {
        clicks += 1;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(clicks).toBe(2);
    const summary = parsedEvents(log).find(
      (event) => event.event === "rakuten_sync_summary",
    );
    expect(summary).toMatchObject({
      outcome: "RakutenCredentialRejectedError",
      stage: "login",
      loginMode: "ocr",
      ocrAttempts: 2,
      depositSource: "none",
    });
    // 只有 OCR 驗證碼錯誤那一次是 warn
    expect(parsedEvents(warn).map((event) => event.event)).toEqual([
      "rakuten_ocr_attempt_failed",
    ]);
    warn.mockRestore();
    log.mockRestore();
  });
});

describe("Rakuten deposit parsing failure", () => {
  it("fails without logging page content when no deposit can be parsed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: "臺幣存款\n載入中",
      tapDashboard: {},
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toThrow("解析不到臺幣存款資料");

    const logged = warn.mock.calls.map(([value]) => String(value)).join("\n");
    expect(logged).toContain('"accountCount":0');
    expect(logged).not.toContain("載入中");
    warn.mockRestore();
    log.mockRestore();
  }, 15_000);
});

describe("Rakuten native dialogs and lost-session detection", () => {
  it("dismisses a take-over confirm during login and stops with a session conflict", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const confirm = {
      type: () => "confirm",
      message: () => "帳號重複登入，是否登出其他裝置並繼續？",
      accept: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
    };
    const browserPage = makePage({
      onLoginClick: () => {
        const handler = browserPage.on.mock.calls.find(
          ([event]) => event === "dialog",
        )?.[1] as ((dialog: unknown) => void) | undefined;
        handler?.(confirm);
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("36CY");

    await expect(
      createRakutenConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenSessionConflictError);

    expect(confirm.dismiss).toHaveBeenCalledOnce();
    expect(confirm.accept).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    log.mockRestore();
    warn.mockRestore();
  });
});

describe("Rakuten decrypted response tap and logout", () => {
  it("installs the response tap before loading the bank page", async () => {
    const browserPage = makePage();
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await prepareRakutenCaptcha({} as Fetcher, credentials);

    expect(browserPage.evaluateOnNewDocument).toHaveBeenCalledOnce();
    expect(
      browserPage.evaluateOnNewDocument.mock.invocationCallOrder[0],
    ).toBeLessThan(browserPage.goto.mock.invocationCallOrder[0]!);
  });

  it("logs out through the logout confirmation after a successful sync", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    expect(browserPage.state.navClicks).toContainEqual({ exact: "登出" });
    expect(browserPage.state.logoutConfirmed).toBe(true);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(log.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
      '"event":"rakuten_logout","result":"logged_out"',
    );
    log.mockRestore();
    warn.mockRestore();
  });

  it("still logs out when parsing fails after a successful login", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      tapDashboard: {},
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenConnectionError);

    expect(browserPage.state.logoutConfirmed).toBe(true);
    log.mockRestore();
    warn.mockRestore();
  }, 15_000);

  it("does not try to log out when login itself failed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({ modalText: "使用者代號或密碼錯誤" });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        {} as Fetcher,
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(browserPage.state.navClicks ?? []).not.toContainEqual({
      exact: "登出",
    });
    log.mockRestore();
    warn.mockRestore();
  });

  it("keeps the sync result and warns when the logout confirmation never appears", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    const originalEvaluate = browserPage.evaluate.getMockImplementation();
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown, arg?: unknown) =>
        String(fn).includes("確認登出")
          ? "no_modal"
          : originalEvaluate?.(fn, arg),
    );
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    const result = await createRakutenConnector(
      {} as Fetcher,
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    expect(result.bankAccounts?.length).toBeGreaterThan(0);
    expect(
      warn.mock.calls.map(([value]) => String(value)).join("\n"),
    ).toContain('"event":"rakuten_logout","result":"no_confirm_modal"');
    log.mockRestore();
    warn.mockRestore();
  }, 15_000);
});

describe("installRakutenResponseTap (runs inside the bank page)", () => {
  type Tap = {
    lastPath: string;
    responses: Array<{ path: string; statusCode: string; rsData: unknown }>;
  };

  it("records decrypted responses with the path of the XHR that produced them", () => {
    const originalParse = JSON.parse;
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousWindow = globals.window;
    const previousXhr = globals.XMLHttpRequest;
    class FakeXhr {
      listeners: Array<() => void> = [];
      open(_method: string, _url: string) {}
      addEventListener(_event: string, listener: () => void) {
        this.listeners.push(listener);
      }
      finish() {
        for (const listener of this.listeners) listener();
      }
    }
    globals.XMLHttpRequest = FakeXhr;
    globals.window = {
      location: {
        href: "https://www.rakuten-bank.com.tw/ebank/chm/chmqu0001/010",
      },
    };
    try {
      installRakutenResponseTap();
      installRakutenResponseTap(); // 重複安裝不會包兩層
      const tap = (globals.window as { __tfhRakutenTap: Tap }).__tfhRakutenTap;

      const dashboard = new FakeXhr();
      dashboard.open(
        "POST",
        "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0001/010?t=1",
      );
      dashboard.finish();
      // 網路層的外層（rsData 為密文字串）不記錄
      JSON.parse('{"rsData":"U2FsdGVkX19encrypted"}');
      // 網頁自己解密後的內容才記錄
      const decrypted = JSON.parse(
        '{"statusCode":"0000","rsData":{"depositInfo":{"depAccounts":[]}}}',
      );
      expect(decrypted.rsData.depositInfo).toEqual({ depAccounts: [] });

      const other = new FakeXhr();
      other.open(
        "POST",
        "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0002/010",
      );
      other.finish();
      JSON.parse('{"statusCode":"E001","rsData":{"items":[]}}');
      // reviver 等一般用法不受影響
      expect(JSON.parse('{"a":1}', (_key, value) => value)).toEqual({ a: 1 });

      expect(tap.responses).toEqual([
        {
          path: "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0001/010",
          statusCode: "0000",
          rsData: { depositInfo: { depAccounts: [] } },
        },
        {
          path: "/ixtein/adapters/ebank/txns/channel-chm/CHMQU0002/010",
          statusCode: "E001",
          rsData: { items: [] },
        },
      ]);
    } finally {
      JSON.parse = originalParse;
      globals.window = previousWindow;
      globals.XMLHttpRequest = previousXhr;
    }
  });
});

describe("Rakuten OCR helpers", () => {
  it("classifies login modal texts", () => {
    expect(classifyRakutenLoginText("")).toBe("unknown");
    expect(classifyRakutenLoginText("圖形驗證碼錯誤，請重新輸入")).toBe(
      "captcha",
    );
    expect(classifyRakutenLoginText("身分證字號、使用者代號或密碼錯誤")).toBe(
      "credential",
    );
    expect(classifyRakutenLoginText("您的帳號已在其他裝置登入")).toBe(
      "session_conflict",
    );
    expect(classifyRakutenLoginText("系統維護中")).toBe("maintenance");
    expect(classifyRakutenLoginText("請輸入簡訊 OTP 驗證碼完成裝置綁定")).toBe(
      "device_binding",
    );
  });

  it("normalizes OCR answers and rejects wrong lengths as CAPTCHA errors", () => {
    expect(normalizeRakutenCaptchaAnswer(" aB 3x\n")).toBe("aB3x");
    expect(normalizeRakutenCaptchaAnswer('"7K2p".')).toBe("7K2p");
    expect(() => normalizeRakutenCaptchaAnswer("abc")).toThrow(
      RakutenCaptchaRejectedError,
    );
    expect(() => normalizeRakutenCaptchaAnswer("abcde")).toThrow(
      RakutenCaptchaRejectedError,
    );
    expect(() => normalizeRakutenCaptchaAnswer(undefined)).toThrow(
      RakutenCaptchaRejectedError,
    );
  });

  it("decodes CAPTCHA data URIs", () => {
    const { bytes, contentType } = dataUriToBuffer(
      "data:image/png;base64,AAEC",
    );
    expect(contentType).toBe("image/png");
    expect([...new Uint8Array(bytes)]).toEqual([0, 1, 2]);
    expect(() => dataUriToBuffer("not-a-data-uri")).toThrow(
      RakutenConnectionError,
    );
  });
});

describe("runRakutenOcrAttempts", () => {
  const always = { maxAttempts: 3, hasTimeForAttempt: () => true };

  it("retries after a CAPTCHA rejection and stops on success", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new RakutenCaptchaRejectedError("wrong"))
      .mockResolvedValueOnce(undefined);

    await runRakutenOcrAttempts(attempt, always);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("reports every failed attempt and ends with an exhausted error", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCaptchaRejectedError("wrong"));
    const onAttemptFailed = vi.fn();

    const error = await runRakutenOcrAttempts(attempt, {
      ...always,
      onAttemptFailed,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("exhausted");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onAttemptFailed.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
  });

  it("rethrows credential rejections immediately", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCredentialRejectedError("bad password"));

    await expect(runRakutenOcrAttempts(attempt, always)).rejects.toBeInstanceOf(
      RakutenCredentialRejectedError,
    );
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("rethrows connection errors immediately", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenConnectionError("unknown outcome"));

    const error = await runRakutenOcrAttempts(attempt, always).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RakutenConnectionError);
    expect(error).not.toBeInstanceOf(RakutenAutoCaptchaFailedError);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("maps recognizer failures to recognizer_unavailable without retrying", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCaptchaRecognizerError("AI down"));

    const error = await runRakutenOcrAttempts(attempt, always).catch(
      (reason: unknown) => reason,
    );
    expect((error as RakutenAutoCaptchaFailedError).reason).toBe(
      "recognizer_unavailable",
    );
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("reports out_of_time when no attempt fits in the remaining budget", async () => {
    const attempt = vi.fn();

    const error = await runRakutenOcrAttempts(attempt, {
      maxAttempts: 3,
      hasTimeForAttempt: () => false,
    }).catch((reason: unknown) => reason);

    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("out_of_time");
    expect(attempt).not.toHaveBeenCalled();
  });

  it("counts only attempts actually made when time runs out mid-way", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new RakutenCaptchaRejectedError("wrong"));
    let budget = 1;

    const error = await runRakutenOcrAttempts(attempt, {
      maxAttempts: 3,
      hasTimeForAttempt: () => budget-- > 0,
    }).catch((reason: unknown) => reason);

    expect((error as RakutenAutoCaptchaFailedError).reason).toBe("exhausted");
    expect((error as Error).message).toContain("1 次");
    expect(attempt).toHaveBeenCalledOnce();
  });
});
