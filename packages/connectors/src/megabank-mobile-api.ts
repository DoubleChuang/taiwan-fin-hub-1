import type { SyncResult } from "@taiwan-fin-hub/core";
import forge from "node-forge";
import {
  parseMegabankData,
  type MegabankConfig,
  type MegabankPayloads,
} from "./megabank";
import {
  application,
  clientPublicKey,
  clientToken,
  detailVersion,
} from "./megabank-app-settings";
import { BANK_SYNC_MONTHS } from "./sync-window";

const ROOT = "https://mobile.megabank.com.tw/ixtein";
const REQUEST_TIMEOUT_MS = 45_000;
const PENDING_SESSION_TTL_MS = 2 * 60_000;
const MAX_TRANSACTION_PAGES = 20;
type JsonRecord = Record<string, unknown>;
type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type Credentials = Required<
  Pick<MegabankConfig, "userId" | "account" | "password">
>;
type SessionState = {
  version: 1;
  accessToken: string;
  xAuthToken: string;
  cookies: Record<string, string>;
  deviceCode: string;
  deviceUKey: string;
  seed: string;
  txnToken: string;
  clientNo: string;
};

export type MegabankCaptchaChallenge = {
  captchaImage: string;
  contentType: string;
  imageBytes: ArrayBuffer;
  pendingSession: string;
  pendingSessionExpiresAt: string;
};

export class MegabankVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MegabankVerificationRequiredError";
  }
}
export class MegabankConnectionError extends Error {
  constructor(message = "兆豐銀行服務暫時無法連線。") {
    super(message);
    this.name = "MegabankConnectionError";
  }
}
export class MegabankProtocolError extends Error {
  constructor(message = "兆豐銀行回應格式已變更。") {
    super(message);
    this.name = "MegabankProtocolError";
  }
}

export function requireMegabankCredentials(
  config: MegabankConfig,
): Credentials {
  if (!config.userId?.trim() || !config.account?.trim() || !config.password) {
    throw new MegabankVerificationRequiredError(
      "請先儲存兆豐銀行身分證字號、使用者代號與登入密碼。",
    );
  }
  return {
    userId: config.userId.trim().toUpperCase(),
    account: config.account.trim().toUpperCase(),
    password: config.password,
  };
}

export async function prepareMegabankCaptcha(
  config: MegabankConfig,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): Promise<MegabankCaptchaChallenge> {
  requireMegabankCredentials(config);
  const session = new MegabankSession(fetcher);
  await session.bootstrap();
  const image = await session.resource(
    "prelogin",
    "/fco/fco00001/captcha",
    {},
    "fco02003",
    "login",
  );
  const encoded = stringAt(dataAt(image), "image");
  if (!encoded) throw new MegabankProtocolError("兆豐銀行未回傳圖形驗證碼。");
  const data = encoded.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) {
    throw new MegabankProtocolError("兆豐銀行圖形驗證碼格式已變更。");
  }
  const bytes = forge.util.decode64(data);
  const imageBytes = Uint8Array.from(bytes, (character) =>
    character.charCodeAt(0),
  ).buffer;
  return {
    captchaImage: `data:image/jpeg;base64,${data}`,
    contentType: "image/jpeg",
    imageBytes,
    pendingSession: session.serialize(),
    pendingSessionExpiresAt: new Date(
      Date.now() + PENDING_SESSION_TTL_MS,
    ).toISOString(),
  };
}

export function createMegabankConnector(
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  recognizeCaptcha?: (
    bytes: ArrayBuffer,
    contentType: string,
  ) => Promise<string>,
) {
  return {
    id: "megabank" as const,
    name: "兆豐銀行",
    async sync(
      config: MegabankConfig,
      _cursor?: string,
    ): Promise<SyncResult<never>> {
      const credentials = requireMegabankCredentials(config);
      let session: MegabankSession;
      let captcha = config.captcha;
      if (
        config.pendingSession &&
        config.pendingSessionExpiresAt &&
        Date.parse(config.pendingSessionExpiresAt) > Date.now()
      ) {
        session = MegabankSession.deserialize(config.pendingSession, fetcher);
      } else {
        const challenge = await prepareMegabankCaptcha(config, fetcher);
        if (!recognizeCaptcha) {
          throw new MegabankVerificationRequiredError(
            "兆豐銀行同步需要先完成圖形驗證。",
          );
        }
        captcha = await recognizeCaptcha(
          challenge.imageBytes,
          challenge.contentType,
        );
        session = MegabankSession.deserialize(
          challenge.pendingSession,
          fetcher,
        );
      }
      if (!captcha || !/^\d{5}$/.test(captcha)) {
        throw new MegabankVerificationRequiredError(
          "請輸入兆豐銀行圖片中的五位數字驗證碼。",
        );
      }
      try {
        await session.login(credentials, captcha);
        const deposits = await session.resource(
          "megapmb",
          "/fco/fco10001/home",
          { type: "1", refresh: true },
          "fco10001",
          "home",
        );
        if (!Array.isArray(dataAt(deposits).depositInfoList)) {
          throw new MegabankProtocolError(
            "兆豐存款清單格式已變更，未更新資料。",
          );
        }
        const cardOverview = await session.resource(
          "megapmb",
          "/fco/fco10007/home",
          {},
          "fco10007",
          "home",
        );
        if (!Array.isArray(dataAt(cardOverview).creditCardBillInfoList)) {
          throw new MegabankProtocolError(
            "兆豐信用卡總覽格式已變更，未更新資料。",
          );
        }
        const cardBills = await session.resource(
          "megapmb",
          "/fao/fao01009/home",
          {},
          "fao01009",
          "home",
        );
        const billData = dataAt(cardBills);
        if (
          !["generalRecordList", "fancyRecordList", "ridoRecordList"].some(
            (key) => Array.isArray(billData[key]),
          )
        ) {
          throw new MegabankProtocolError(
            "兆豐信用卡帳單格式已變更，未更新資料。",
          );
        }
        const cardHome = await session.resource(
          "megapmb",
          "/fao/fao01010/home",
          {},
          "fao01010",
          "home",
        );
        if (!Array.isArray(dataAt(cardHome).cardNumbers)) {
          throw new MegabankProtocolError(
            "兆豐信用卡清單格式已變更，未更新資料。",
          );
        }
        const start = new Date();
        start.setMonth(start.getMonth() - BANK_SYNC_MONTHS);
        const startDate = localDate(start);
        const endDate = localDate(new Date());
        const cardNumbers = arrayAt(dataAt(cardHome), "cardNumbers");
        const cardTransactions =
          cardNumbers.length > 0
            ? await session.resource(
                "megapmb",
                "/fao/fao01010/query",
                { cardNo: "0", flag: "0", startDate, endDate },
                "fao01010",
                "query",
              )
            : { rsData: { detailList: [] } };
        const cardTransactionData = dataAt(cardTransactions);
        if (!Array.isArray(cardTransactionData.detailList)) {
          throw new MegabankProtocolError(
            "兆豐信用卡消費明細格式已變更，未更新資料。",
          );
        }
        const depositTransactions: MegabankPayloads["depositTransactions"] = [];
        const queriedAccounts = new Set<string>();
        for (const item of arrayAt(dataAt(deposits), "depositInfoList")) {
          if (!isRecord(item)) continue;
          const accountNo = stringAt(item, "DRACT");
          const currency = stringAt(item, "DRCUR");
          if (
            !accountNo ||
            currency !== "TWD" ||
            queriedAccounts.has(accountNo)
          )
            continue;
          queriedAccounts.add(accountNo);
          let tsqName = "";
          for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
            const response = await session.resource(
              "megapmb",
              "/fao/fao01001/query",
              {
                currency,
                accountNo,
                accountTitle: "",
                startDate,
                endDate,
                count: "20",
                isDw: false,
                tsqName,
                isReturn: false,
              },
              "fao01001",
              "query",
            );
            depositTransactions.push({ accountNo, currency, response });
            const next = stringAt(dataAt(response), "tsqName");
            if (!next || next === tsqName) break;
            if (page === MAX_TRANSACTION_PAGES - 1) {
              throw new MegabankProtocolError(
                "兆豐存款交易分頁超過安全上限，未更新資料。",
              );
            }
            tsqName = next;
          }
        }
        let parsed;
        try {
          parsed = parseMegabankData({
            deposits,
            depositTransactions,
            cardOverview,
            cardBills,
            cardHome,
            cardTransactions,
          });
        } catch {
          throw new MegabankProtocolError(
            "兆豐銀行帳務欄位無法完整辨識，未更新資料。",
          );
        }
        if (
          arrayAt(dataAt(deposits), "depositInfoList").length > 0 &&
          parsed.bankAccounts.every(
            (account) => account.accountType === "credit",
          )
        ) {
          throw new MegabankProtocolError("兆豐存款資料無法辨識，未更新資料。");
        }
        if (
          cardNumbers.length > 0 &&
          parsed.bankAccounts.every(
            (account) => account.accountType !== "credit",
          )
        ) {
          throw new MegabankProtocolError(
            "兆豐信用卡資料無法辨識，未更新資料。",
          );
        }
        return {
          records: [],
          ...parsed,
          cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
        };
      } finally {
        await session.logout();
      }
    },
  };
}

class MegabankSession {
  private accessToken = "";
  private xAuthToken = "";
  private authenticated = false;
  private readonly cookies = new Map<string, string>();
  private deviceCode: string = crypto.randomUUID();
  private deviceUKey: string = crypto.randomUUID();
  private seed: string = crypto.randomUUID();
  private txnToken = String(Date.now());
  private clientNo = String(Date.now());

  constructor(private readonly fetcher: Fetcher) {}

  static deserialize(serialized: string, fetcher: Fetcher): MegabankSession {
    let state: SessionState;
    try {
      state = JSON.parse(serialized) as SessionState;
    } catch {
      throw new MegabankVerificationRequiredError(
        "兆豐銀行驗證工作階段已失效，請重新取得驗證碼。",
      );
    }
    if (
      state.version !== 1 ||
      !state.accessToken ||
      !state.deviceCode ||
      !state.deviceUKey ||
      !state.seed ||
      !state.clientNo ||
      !state.cookies ||
      typeof state.cookies !== "object"
    ) {
      throw new MegabankVerificationRequiredError(
        "兆豐銀行驗證工作階段已失效，請重新取得驗證碼。",
      );
    }
    const session = new MegabankSession(fetcher);
    session.accessToken = state.accessToken;
    session.xAuthToken = state.xAuthToken || "";
    session.txnToken = state.txnToken || String(Date.now());
    session.deviceCode = state.deviceCode;
    session.deviceUKey = state.deviceUKey;
    session.seed = state.seed;
    session.clientNo = state.clientNo;
    for (const [name, value] of Object.entries(state.cookies)) {
      if (typeof value === "string") session.cookies.set(name, value);
    }
    return session;
  }

  serialize(): string {
    return JSON.stringify({
      version: 1,
      accessToken: this.accessToken,
      xAuthToken: this.xAuthToken,
      cookies: Object.fromEntries(this.cookies),
      deviceCode: this.deviceCode,
      deviceUKey: this.deviceUKey,
      seed: this.seed,
      txnToken: this.txnToken,
      clientNo: this.clientNo,
    } satisfies SessionState);
  }

  async bootstrap(): Promise<void> {
    const oauth = await this.request(
      "/oauth/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        scope: "PUBLIC",
        client_id: application,
        client_secret: clientToken,
      }).toString(),
      true,
    );
    this.accessToken = stringAt(oauth, "access_token");
    if (!this.accessToken)
      throw new MegabankConnectionError("兆豐銀行行動服務初始化失敗。");
    const handshake = await this.request(
      "/main/init",
      JSON.stringify({
        application,
        deviceCode: this.deviceCode,
        deviceManufacturer: "Generic",
        deviceModel: "Desktop",
        devicePlatform: "Android",
        deviceVersion: "16",
        pclientTime: Date.now(),
        randomNumber: "",
        clientPubk: clientPublicKey,
      }),
    );
    if (stringAt(handshake, "statusCode") !== "0000") {
      throw new MegabankConnectionError("兆豐銀行安全連線初始化失敗。");
    }
    await this.resource("ixtein-pmbinit", "/fco/fco00001/initialize", {});
  }

  async login(credentials: Credentials, captcha: string): Promise<void> {
    const e2ee = await this.resource(
      "prelogin",
      "/fco/fco00001/e2ee",
      {},
      "fco02003",
      "login",
    );
    const data = dataAt(e2ee);
    let cipherToken: JsonRecord;
    try {
      cipherToken = JSON.parse(stringAt(data, "cipherToken")) as JsonRecord;
    } catch {
      throw new MegabankProtocolError("兆豐銀行登入加密參數格式已變更。");
    }
    if (data.isE2EE !== true || !isRecord(cipherToken)) {
      throw new MegabankProtocolError("兆豐銀行登入加密參數不可用。");
    }
    const e2eeData = encryptLogin(credentials, cipherToken);
    const response = await this.resource(
      "prelogin",
      "/fco/fco02003/login",
      {
        memberType: "NB",
        cipherToken: JSON.stringify(cipherToken),
        e2eeData,
        isE2EE: true,
        pxdLength: credentials.password.length,
        isDeviceBinded: false,
        captchaCode: captcha,
      },
      "fco02003",
      "login",
      true,
    );
    const code = stringAt(response, "code");
    if (code === "0113") {
      throw new MegabankVerificationRequiredError(
        "兆豐銀行圖形驗證碼錯誤，請重新取得驗證碼。",
      );
    }
    if (code !== "0000") {
      throw new MegabankVerificationRequiredError(
        "兆豐銀行登入未通過，請至官方 App 確認登入資料或驗證要求。",
      );
    }
    this.authenticated = true;
    await this.adapterRequest("resource/login", {});
  }

  async logout(): Promise<void> {
    if (!this.authenticated) return;
    this.authenticated = false;
    try {
      await this.resource(
        "megapmb",
        "/fco/fco02011/logout",
        {},
        undefined,
        undefined,
        true,
      );
    } catch {
      // A failed logout must not replace the sync result or its original error.
    }
  }

  async resource(
    endpoint: string,
    resource: string,
    rqData: JsonRecord,
    pageId?: string,
    pageNo?: string,
    skipCodeCheck = false,
  ): Promise<JsonRecord> {
    const trackingIxd = crypto.randomUUID();
    const payload = {
      ...(pageId ? { pageId } : {}),
      ...(pageNo ? { pageNo } : {}),
      deviceIxd: this.deviceCode,
      deviceUKey: this.deviceUKey,
      trackingIxd,
      txnIxd: "",
      model: "Desktop",
      platform: "Android",
      version: "16",
      network: "wifi",
      appVer: "2.5.19",
      appDetailVer: detailVersion,
      clientNo: this.clientNo,
      clientTime: String(Date.now()),
      token: this.txnToken,
      locale: "zh_TW",
      fromSys: "0",
      seed: this.seed,
      deviceToken: "",
      rqData,
      clientSysId: "NMB",
      deviceUniqueIxd: this.deviceCode,
      resource,
    };
    const body = JSON.stringify(payload);
    const result = await this.request(
      `/v2/adapters/ibmb/imp-pmb-adapter/resource/${endpoint}`,
      body,
      false,
      {
        checksum: md5(body),
        deviceCode: this.deviceCode,
        "x-track-ixd": trackingIxd,
        ...(this.xAuthToken ? { "x-auth-token": this.xAuthToken } : {}),
      },
    );
    const rawCode = stringAt(result, "code");
    const code = /^[A-Za-z0-9_-]{1,32}$/.test(rawCode) ? rawCode : "unknown";
    if (!skipCodeCheck && code !== "0000" && code !== "1120") {
      throw new MegabankProtocolError(
        `兆豐銀行查詢失敗（代碼 ${code}）。${code === "SYS014" ? "若目前已登入兆豐網銀，請登出後再試。" : ""}`,
      );
    }
    return result;
  }

  private adapterRequest(
    path: string,
    payload: JsonRecord,
  ): Promise<JsonRecord> {
    const body = JSON.stringify(payload);
    return this.request(
      `/v2/adapters/ibmb/imp-pmb-adapter/${path}`,
      body,
      false,
      {
        checksum: md5(body),
        deviceCode: this.deviceCode,
        "x-track-ixd": crypto.randomUUID(),
      },
    );
  }

  private async request(
    path: string,
    body: string,
    form = false,
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonRecord> {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
      ...extraHeaders,
    });
    if (this.accessToken)
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (this.cookies.size) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    let response: Response;
    try {
      response = await this.fetcher(ROOT + path, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MegabankConnectionError();
    }
    const setCookies = getSetCookieValues(response.headers);
    for (const line of setCookies) {
      const pair = line.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) {
        this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
    if (!response.ok) {
      throw new MegabankConnectionError(
        `兆豐銀行服務回應 HTTP ${response.status}。`,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new MegabankProtocolError();
    }
    if (!isRecord(json)) throw new MegabankProtocolError();
    const xAuthToken = response.headers.get("x-auth-token");
    if (xAuthToken) this.xAuthToken = xAuthToken;
    const token = stringAt(json, "token");
    if (token) this.txnToken = token;
    return json;
  }
}

export function encryptLogin(
  credentials: Credentials,
  token: JsonRecord,
): string {
  const keyHex = stringAt(token, "SessionKey");
  const modulus = stringAt(token, "RSAPublicKeyModulus");
  const exponent = stringAt(token, "RSAPublicKeyExponent");
  if (
    !/^[\da-fA-F]+$/.test(keyHex) ||
    ![32, 48].includes(keyHex.length) ||
    !/^[\da-fA-F]+$/.test(modulus) ||
    !/^[\da-fA-F]+$/.test(exponent)
  ) {
    throw new MegabankProtocolError("兆豐銀行登入加密金鑰格式已變更。");
  }
  const key = forge.util.hexToBytes(keyHex);
  const tripleDesKey = key.length === 16 ? key + key.slice(0, 8) : key;
  const padded =
    credentials.password +
    " ".repeat((16 - (credentials.password.length % 16)) % 16);
  const des = forge.cipher.createCipher("3DES-CBC", tripleDesKey);
  des.start({ iv: "\0".repeat(8) });
  des.update(forge.util.createBuffer(padded, "utf8"));
  if (!des.finish()) throw new MegabankProtocolError("兆豐銀行登入加密失敗。");
  const publicKey = forge.pki.setRsaPublicKey(
    new forge.jsbn.BigInteger(modulus, 16),
    new forge.jsbn.BigInteger(exponent, 16),
  );
  const plain =
    `${credentials.userId}|${credentials.account}/` + des.output.getBytes();
  try {
    return forge.util
      .bytesToHex(publicKey.encrypt(plain, "RSAES-PKCS1-V1_5"))
      .replace(/^0+/, "");
  } catch {
    throw new MegabankProtocolError("兆豐銀行登入加密失敗。");
  }
}

function md5(value: string): string {
  return forge.md.md5.create().update(value, "utf8").digest().toHex();
}
function dataAt(value: unknown): JsonRecord {
  return isRecord(value) && isRecord(value.rsData) ? value.rsData : {};
}
function arrayAt(value: JsonRecord, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : [];
}
function stringAt(value: JsonRecord, key: string): string {
  return typeof value[key] === "string" ? value[key].trim() : "";
}
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function localDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replaceAll("-", "/");
}
function getSetCookieValues(headers: Headers): string[] {
  const direct = headers.getSetCookie?.();
  if (direct?.length) return direct;
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g) : [];
}
