# 台灣端雙軌 Relay 服務 (Taiwan Dual-Track Relay)

此服務用於將 Taiwan Fin Hub 的連線出口導向台灣家用寬頻（如中華電信光世代/固寬），徹底解決第一銀行、華南銀行等爬蟲以及中信、新光等 API 連接器被海外或 Cloudflare 資料中心 IP 標記阻擋的問題。

---

## 包含組件

1. **`http-relay` (Port 8788)**: 輕量 Node.js 轉發伺服器，負責中信、新光、王道、電子發票等純 HTTP API 請求。
2. **`chrome` (Port 9222)**: `browserless/chrome` 無頭 Chrome 容器，提供標準 CDP WebSocket 介面，負責一銀、華南、國泰、台新等網銀爬蟲。
3. **`cloudflared`**: Cloudflare Tunnel 客戶端，免開 Port、免固定 IP、免 DDNS，建立反向加密通道。

---

## 快速開始

### 步驟 1：建立 Cloudflare Tunnel

1. 前往 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/) -> **Networks** -> **Tunnels**。
2. 點擊 **Create a tunnel**，選擇 **Cloudflared**。
3. 輸入 Tunnel 名稱（例如 `taiwan-fin-relay`），複製產生的 Tunnel Token。
4. 在 **Public Hostnames** 分頁新增一筆路由（以 `relay.yourdomain.com` 為例）：
   - **Hostname**: `relay.yourdomain.com`
   - **Path**: `proxy`
   - **Service**: `HTTP` -> `http-relay:8788`
5. 新增第二筆路由給 Chrome CDP：
   - **Hostname**: `relay.yourdomain.com`
   - **Path**: `devtools`
   - **Service**: `HTTP` -> `chrome:3000` (請在 Additional application settings 中確認支援 **No TLS Verify** 或依照需求設定，並開啟 **HTTP2 connection** / **WebSockets**)。
   - _或者將根路徑導向不同子網域_：例如 `relay-http.yourdomain.com` 導向 `http-relay:8788`，`relay-cdp.yourdomain.com` 導向 `chrome:3000`。

### 步驟 2：設定環境變數

在台灣主機複製 `.env.example` 為 `.env`：

```bash
cp .env.example .env
```

編輯 `.env`：

- `RELAY_SECRET_TOKEN`: 設定長度至少 32 字元的隨機密鑰。
- `CLOUDFLARE_TUNNEL_TOKEN`: 貼上 Cloudflare Tunnel Token。

### 步驟 3：啟動服務

```bash
docker compose up -d
```

檢視狀態：

```bash
docker compose ps
docker compose logs -f
```

### 步驟 4：測試連線

測試 HTTP Relay 健康端點：

```bash
curl -i http://127.0.0.1:8788/health
# 應回傳 200 {"status":"ok"}
```

測試驗證轉發（以中信為例）：

```bash
curl -i -X POST http://127.0.0.1:8788/proxy \
  -H "x-relay-token: YOUR_SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://eb.ctbcbank.com/IMP/","method":"GET","headers":{}}'
```

---

## 在 Taiwan Fin Hub Worker 設定

在 Worker 的 `wrangler.toml`（或 Cloudflare Worker Secrets）配置以下環境變數：

```toml
[vars]
RELAY_HTTP_URL = "https://relay.yourdomain.com/proxy"
RELAY_HTTP_TOKEN = "YOUR_SECRET_TOKEN"
RELAY_CDP_WS_ENDPOINT = "wss://relay.yourdomain.com/devtools/browser?token=YOUR_SECRET_TOKEN"
```
