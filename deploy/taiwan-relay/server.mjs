import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "0.0.0.0";
const RELAY_TOKEN = process.env.RELAY_TOKEN?.trim();

const DEFAULT_ALLOWED_ORIGINS = [
  "https://eb.ctbcbank.com",
  "https://*.skbank.com.tw",
  "https://*.obank.com.tw",
  "https://api.einvoice.nat.gov.tw",
  "https://*.tdcc.com.tw",
  "https://*.esunbank.com.tw",
  "https://*.firstbank.com.tw",
  "https://*.hncb.com.tw",
  "https://*.cathaybk.com.tw",
  "https://*.taishinbank.com.tw",
  "https://*.kgibank.com.tw",
];

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

if (!RELAY_TOKEN) {
  console.error("FATAL: RELAY_TOKEN environment variable is required.");
  process.exit(1);
}

function isOriginAllowed(urlOrigin) {
  return allowedOrigins.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === urlOrigin) return true;
    if (pattern.startsWith("https://*.")) {
      const suffix = pattern.slice("https://*.".length);
      try {
        const hostname = new URL(urlOrigin).hostname;
        return hostname === suffix || hostname.endsWith("." + suffix);
      } catch {
        return false;
      }
    }
    return false;
  });
}

function isStringRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

async function readRequest(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error("Request body too large");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const token =
    request.headers["x-relay-token"] || request.headers["x-ctbc-relay-token"];
  if (token !== RELAY_TOKEN) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ error: "Unauthorized: Invalid relay token" }),
    );
    return;
  }

  if (
    request.method !== "POST" ||
    (request.url !== "/proxy" && request.url !== "/ctbc")
  ) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  try {
    const rawBody = await readRequest(request, MAX_REQUEST_BYTES);
    const payload = JSON.parse(rawBody);

    if (
      typeof payload !== "object" ||
      !payload ||
      typeof payload.url !== "string" ||
      typeof payload.method !== "string" ||
      !isStringRecord(payload.headers || {})
    ) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid proxy payload" }));
      return;
    }

    const targetUrl = new URL(payload.url);
    if (!isOriginAllowed(targetUrl.origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: `Forbidden: Target origin '${targetUrl.origin}' is not in allowed list`,
        }),
      );
      return;
    }

    const upstreamHeaders = { ...payload.headers };
    delete upstreamHeaders["host"];

    const upstream = await fetch(targetUrl, {
      method: payload.method.toUpperCase(),
      headers: upstreamHeaders,
      body:
        payload.method.toUpperCase() === "GET" ||
        payload.method.toUpperCase() === "HEAD"
          ? undefined
          : typeof payload.body === "string"
            ? payload.body
            : undefined,
      redirect: "manual",
    });

    const responseBytes = new Uint8Array(await upstream.arrayBuffer());
    if (responseBytes.byteLength > MAX_RESPONSE_BYTES) {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Upstream response too large" }));
      return;
    }

    const responseHeaders = {};
    for (const [name, value] of upstream.headers.entries()) {
      if (
        name.toLowerCase() !== "transfer-encoding" &&
        name.toLowerCase() !== "content-length"
      ) {
        responseHeaders[name] = value;
      }
    }

    response.writeHead(upstream.status, responseHeaders);
    response.end(responseBytes);
  } catch (error) {
    const status = error?.code === "REQUEST_TOO_LARGE" ? 413 : 502;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error:
          error instanceof Error ? error.message : "Proxy execution failed",
      }),
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Taiwan HTTP Relay listening on http://${HOST}:${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
});
