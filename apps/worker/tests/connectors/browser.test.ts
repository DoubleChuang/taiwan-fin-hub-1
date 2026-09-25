import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch, connect } }));
import {
  createBrowserBinding,
  launchBrowserWithRetry,
} from "../../src/connectors/browser";

type Binding = Parameters<typeof launchBrowserWithRetry>[0];
const acquisitionUrl = "https://fake.host/v1/devtools/browser?keep_alive=60000";

describe("browser acquisition retry", () => {
  beforeEach(() => {
    launch.mockReset();
    launch.mockImplementation((binding: Binding) =>
      binding.fetch(acquisitionUrl, { method: "POST" }),
    );
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns success immediately and preserves launch options", async () => {
    const response = new Response("session");
    const fetch = vi.fn().mockResolvedValue(response);
    const options = { keep_alive: 60000 };
    await expect(launchBrowserWithRetry({ fetch }, options)).resolves.toBe(
      response,
    );
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fetch: expect.any(Function) }),
      options,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries by status regardless of response text and preserves the request", async () => {
    const failed = new Response("服務暫時不可用", { status: 503 });
    const response = new Response("session");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(response);
    launch.mockImplementation((binding: Binding) =>
      binding.fetch(
        new Request(acquisitionUrl, {
          method: "POST",
          headers: { "X-Test": "preserved" },
          body: "payload",
        }),
      ),
    );
    const result = launchBrowserWithRetry({ fetch });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failed.bodyUsed).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [request] of fetch.mock.calls) {
      expect(request.url).toBe(acquisitionUrl);
      expect(request.method).toBe("POST");
      expect(request.headers.get("X-Test")).toBe("preserved");
      expect(await request.text()).toBe("payload");
    }
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("stops after three attempts and leaves the final response readable", async () => {
    const final = new Response("last failure", { status: 503 });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("first", { status: 503 }))
      .mockResolvedValueOnce(new Response("second", { status: 503 }))
      .mockResolvedValueOnce(final);
    const result = launchBrowserWithRetry({ fetch });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(final);
    expect(await final.text()).toBe("last failure");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 429, 500])(
    "passes through status %s without retry",
    async (status) => {
      const response = new Response("error", { status });
      const fetch = vi.fn().mockResolvedValue(response);
      await expect(launchBrowserWithRetry({ fetch })).resolves.toBe(response);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(response.bodyUsed).toBe(false);
    },
  );

  it.each([
    ["GET", acquisitionUrl],
    ["GET", "https://fake.host/v1/devtools/browser/session-id"],
    ["POST", "https://fake.host/v1/devtools/browser/session-id"],
  ])("does not retry other requests: %s %s", async (method, url) => {
    const response = new Response("unavailable", { status: 503 });
    const fetch = vi.fn().mockResolvedValue(response);
    const init = { method };
    launch.mockImplementation((binding: Binding) => binding.fetch(url, init));
    await expect(launchBrowserWithRetry({ fetch })).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, init);
    expect(response.bodyUsed).toBe(false);
  });

  it("does not retry network exceptions with an unknown acquisition outcome", async () => {
    const error = new Error("connection lost");
    const fetch = vi.fn().mockRejectedValue(error);
    await expect(launchBrowserWithRetry({ fetch })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  describe("remote CDP relay", () => {
    it("connects via puppeteer.connect when relayWsEndpoint is configured", async () => {
      const mockBrowser = { pages: vi.fn().mockResolvedValue([]) };
      connect.mockResolvedValueOnce(mockBrowser);

      const browserBinding = createBrowserBinding({
        BROWSER: { fetch: vi.fn() } as unknown as Fetcher,
        RELAY_CDP_WS_ENDPOINT:
          "wss://relay.example.com/devtools/browser?token=xyz",
      });

      const browser = await launchBrowserWithRetry(browserBinding);
      expect(browser).toBe(mockBrowser);
      expect(connect).toHaveBeenCalledWith({
        browserWSEndpoint: "wss://relay.example.com/devtools/browser?token=xyz",
      });
      expect(launch).not.toHaveBeenCalled();
    });

    it("throws a descriptive error when remote CDP connection fails", async () => {
      connect.mockRejectedValueOnce(new Error("Connection refused"));

      const browserBinding = createBrowserBinding({
        BROWSER: { fetch: vi.fn() } as unknown as Fetcher,
        RELAY_CDP_WS_ENDPOINT:
          "wss://relay.example.com/devtools/browser?token=xyz",
      });

      await expect(launchBrowserWithRetry(browserBinding)).rejects.toThrow(
        "無法連線至台灣 Chrome CDP 端點",
      );
    });

    it("returns original env.BROWSER when RELAY_CDP_WS_ENDPOINT is absent", () => {
      const mockBrowserBinding = { fetch: vi.fn() } as unknown as Fetcher;
      const binding = createBrowserBinding({
        BROWSER: mockBrowserBinding,
      });
      expect(binding).toBe(mockBrowserBinding);
    });
  });
});
