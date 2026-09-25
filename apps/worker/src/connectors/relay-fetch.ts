import type { Env } from "../platform/env";

export type RelayFetch = typeof globalThis.fetch;

export class RelayConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConnectionError";
  }
}

/**
 * Creates a fetch implementation that routes requests through a Taiwan HTTP relay.
 * Supports:
 * 1. Global relay: env.RELAY_HTTP_URL & env.RELAY_HTTP_TOKEN (works in prod & dev)
 * 2. CTBC-specific dev relay fallback: env.CTBC_API_RELAY_URL & env.CTBC_API_RELAY_TOKEN (when LOCAL_DEV_MODE is true)
 */
export function createRelayFetch(
  env: Pick<
    Env,
    | "RELAY_HTTP_URL"
    | "RELAY_HTTP_TOKEN"
    | "LOCAL_DEV_MODE"
    | "CTBC_API_RELAY_URL"
    | "CTBC_API_RELAY_TOKEN"
  >,
  underlyingFetch: RelayFetch = globalThis.fetch.bind(globalThis),
): RelayFetch | undefined {
  const globalRelayUrl = env.RELAY_HTTP_URL?.trim();
  const globalRelayToken = env.RELAY_HTTP_TOKEN?.trim();

  if (globalRelayUrl && globalRelayToken) {
    return async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      const method =
        init.method ?? (input instanceof Request ? input.method : "GET");
      let body: string | undefined;
      if (init.body != null) {
        if (typeof init.body === "string") {
          body = init.body;
        } else if (init.body instanceof URLSearchParams) {
          body = init.body.toString();
        } else {
          throw new RelayConnectionError(
            "Relay 僅支援字串格式之 Request body。",
          );
        }
      }

      const rawHeaders =
        init.headers ?? (input instanceof Request ? input.headers : undefined);
      const targetHeaders = Object.fromEntries(new Headers(rawHeaders));

      return underlyingFetch(globalRelayUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-relay-token": globalRelayToken,
        },
        body: JSON.stringify({
          url,
          method: method.toUpperCase(),
          headers: targetHeaders,
          body: body ?? "",
        }),
        signal: init.signal,
      });
    };
  }

  if (isLocalDev(env.LOCAL_DEV_MODE)) {
    const ctbcRelayUrl = env.CTBC_API_RELAY_URL?.trim();
    const ctbcRelayToken = env.CTBC_API_RELAY_TOKEN?.trim();
    if (ctbcRelayUrl && ctbcRelayToken) {
      return async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = input instanceof Request ? input.url : String(input);
        const method =
          init.method ?? (input instanceof Request ? input.method : "GET");
        let body: string | undefined;
        if (init.body != null) {
          if (typeof init.body === "string") {
            body = init.body;
          } else if (init.body instanceof URLSearchParams) {
            body = init.body.toString();
          } else {
            throw new RelayConnectionError(
              "Relay 僅支援字串格式之 Request body。",
            );
          }
        }

        const rawHeaders =
          init.headers ??
          (input instanceof Request ? input.headers : undefined);
        const targetHeaders = Object.fromEntries(new Headers(rawHeaders));

        return underlyingFetch(ctbcRelayUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-ctbc-relay-token": ctbcRelayToken,
          },
          body: JSON.stringify({
            url,
            method: method.toUpperCase(),
            headers: targetHeaders,
            body: body ?? "",
          }),
          signal: init.signal,
        });
      };
    }
  }

  return undefined;
}

function isLocalDev(value: string | boolean | undefined) {
  if (value === true) return true;
  return (
    typeof value === "string" &&
    ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
}
