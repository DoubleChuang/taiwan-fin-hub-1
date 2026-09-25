import { describe, expect, it, vi } from "vitest";
import {
  createRelayFetch,
  RelayConnectionError,
} from "../../src/connectors/relay-fetch";

describe("createRelayFetch", () => {
  it("returns undefined when no relay environment variables are set", () => {
    const fetcher = createRelayFetch({});
    expect(fetcher).toBeUndefined();
  });

  it("returns undefined when only URL or only token is set for global relay", () => {
    expect(
      createRelayFetch({ RELAY_HTTP_URL: "https://relay.example.com/proxy" }),
    ).toBeUndefined();
    expect(
      createRelayFetch({ RELAY_HTTP_TOKEN: "secret-token" }),
    ).toBeUndefined();
  });

  it("uses global relay when RELAY_HTTP_URL and RELAY_HTTP_TOKEN are set", async () => {
    const mockFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const fetcher = createRelayFetch(
      {
        RELAY_HTTP_URL: "https://relay.example.com/proxy",
        RELAY_HTTP_TOKEN: "my-secret-token",
      },
      mockFetch as typeof globalThis.fetch,
    );

    expect(fetcher).toBeDefined();

    const response = await fetcher!("https://api.example.com/v1/accounts", {
      method: "POST",
      headers: {
        Authorization: "Bearer token123",
        "X-Custom-Header": "custom-val",
      },
      body: JSON.stringify({ accountId: "12345" }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [calledUrl, calledInit] = mockFetch.mock.calls[0]!;
    expect(calledUrl).toBe("https://relay.example.com/proxy");
    expect(calledInit?.method).toBe("POST");

    const headers = new Headers(calledInit?.headers);
    expect(headers.get("x-relay-token")).toBe("my-secret-token");
    expect(headers.get("content-type")).toBe("application/json");

    const sentPayload = JSON.parse(String(calledInit?.body));
    expect(sentPayload).toEqual({
      url: "https://api.example.com/v1/accounts",
      method: "POST",
      headers: {
        authorization: "Bearer token123",
        "x-custom-header": "custom-val",
      },
      body: JSON.stringify({ accountId: "12345" }),
    });
  });

  it("supports URLSearchParams body in relay fetch", async () => {
    const mockFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("ok"),
    );

    const fetcher = createRelayFetch(
      {
        RELAY_HTTP_URL: "https://relay.example.com/proxy",
        RELAY_HTTP_TOKEN: "my-secret-token",
      },
      mockFetch as typeof globalThis.fetch,
    );

    const params = new URLSearchParams({ code: "123", state: "abc" });
    await fetcher!("https://api.example.com/oauth/token", {
      method: "POST",
      body: params,
    });

    const [, calledInit] = mockFetch.mock.calls[0]!;
    const sentPayload = JSON.parse(String(calledInit?.body));
    expect(sentPayload.body).toBe(params.toString());
  });

  it("throws RelayConnectionError for unsupported body formats", async () => {
    const fetcher = createRelayFetch({
      RELAY_HTTP_URL: "https://relay.example.com/proxy",
      RELAY_HTTP_TOKEN: "token",
    });

    await expect(
      fetcher!("https://api.example.com", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
      }),
    ).rejects.toThrow(RelayConnectionError);
  });

  it("falls back to CTBC dev relay when LOCAL_DEV_MODE is true", async () => {
    const mockFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("ok"),
    );

    const fetcher = createRelayFetch(
      {
        LOCAL_DEV_MODE: "true",
        CTBC_API_RELAY_URL: "http://127.0.0.1:9000/ctbc",
        CTBC_API_RELAY_TOKEN: "ctbc-token",
      },
      mockFetch as typeof globalThis.fetch,
    );

    expect(fetcher).toBeDefined();

    await fetcher!("https://eb.ctbcbank.com/IMP/init", {
      method: "POST",
      body: "{}",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0]!;
    expect(calledUrl).toBe("http://127.0.0.1:9000/ctbc");

    const headers = new Headers(calledInit?.headers);
    expect(headers.get("x-ctbc-relay-token")).toBe("ctbc-token");
  });
});
