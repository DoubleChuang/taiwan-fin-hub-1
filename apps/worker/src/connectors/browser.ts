import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../platform/env";

const RETRY_DELAYS_MS = [2_000, 5_000] as const;

export type BrowserBindingWithRelay = Parameters<typeof puppeteer.launch>[0] & {
  relayWsEndpoint?: string;
};

/**
 * Creates a browser binding that routes to a remote Taiwan Chrome CDP endpoint
 * if RELAY_CDP_WS_ENDPOINT is configured in env, or falls back to Cloudflare BROWSER binding.
 */
export function createBrowserBinding(
  env: Pick<Env, "BROWSER" | "RELAY_CDP_WS_ENDPOINT">,
): Fetcher {
  const relayWs = env.RELAY_CDP_WS_ENDPOINT?.trim();
  if (!relayWs) {
    return env.BROWSER;
  }

  const baseFetcher: Fetcher = env.BROWSER ?? {
    async fetch() {
      throw new Error("Cloudflare BROWSER binding is not available.");
    },
  };

  return Object.assign(baseFetcher, { relayWsEndpoint: relayWs });
}

/**
 * Retry only rejected browser acquisition, before a session or login exists.
 * When relayWsEndpoint is configured (either directly or via the binding),
 * connects directly to the remote CDP WebSocket endpoint (e.g. Taiwan Chrome).
 */
export async function launchBrowserWithRetry(
  binding: BrowserBindingWithRelay,
  options?: Parameters<typeof puppeteer.launch>[1],
  relayWsEndpoint?: string,
) {
  const targetWsEndpoint =
    relayWsEndpoint?.trim() || binding?.relayWsEndpoint?.trim();

  if (targetWsEndpoint) {
    try {
      return await puppeteer.connect({
        browserWSEndpoint: targetWsEndpoint,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `無法連線至台灣 Chrome CDP 端點 (${targetWsEndpoint}): ${message}`,
      );
    }
  }

  return puppeteer.launch(
    {
      async fetch(input, init) {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        // This is the acquisition endpoint used by the pinned Puppeteer SDK.
        // Session/CDP requests must pass through without retrying.
        if (
          method.toUpperCase() !== "POST" ||
          url.pathname !== "/v1/devtools/browser"
        ) {
          return binding.fetch(input, init);
        }

        const request = new Request(input, init);
        for (let attempt = 0; ; attempt++) {
          const response = await binding.fetch(request.clone() as Request);
          if (response.status !== 503) return response;

          const delayMs = RETRY_DELAYS_MS[attempt];
          console.warn(
            JSON.stringify({
              event: "browser_acquisition_failed",
              status: response.status,
              attempt: attempt + 1,
              retryDelayMs: delayMs ?? null,
            }),
          );
          // Leave the final response intact for Puppeteer's error handling.
          if (delayMs === undefined) return response;
          await response.body?.cancel();
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      },
    },
    options,
  );
}
