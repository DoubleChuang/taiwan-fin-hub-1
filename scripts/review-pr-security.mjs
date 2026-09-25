import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * 允許的外部網址白名單（台灣銀行業、官方 API 及受信任的基礎建設網域）
 */
export const APPROVED_DOMAINS = [
  // 台灣銀行 / 官方金融 API (明確規範名單)
  "*.cathaybk.com.tw",
  "*.sinopac.com",
  "*.esunbank.com",
  "*.esunbank.com.tw",
  "*.ctbcbank.com",
  "*.taishinbank.com.tw",
  "*.skbank.com.tw",
  "*.o-bank.com",
  "*.obank.com.tw",
  "*.hncb.com.tw",
  "*.firstbank.com.tw",
  "*.kgibank.com.tw",
  "*.einvoice.nat.gov.tw",
  "*.tdcc.com.tw",
  "cloudflareaccess.com",
  "*.cloudflareaccess.com",

  // 專案既有官方/受信任政府及基礎設施網域
  "*.nat.gov.tw",
  "nat.gov.tw",
  "*.cdn.hinet.net",
  "*.cloudflare.com",
  "cloudflare.com",
  "*.github.com",
  "github.com",
  "*.githubusercontent.com",

  // 測試與本機環境網域 (RFC 2606)
  "localhost",
  "127.0.0.1",
  "*.test",
  "*.example",
  "*.invalid",
  "example.com",
  "*.example.com",

  // XML / 協定綱要命名空間
  "*.w3.org",
  "w3.org",
  "openudid.org",
  "*.openudid.org",
];

/**
 * 核心加密與安全性敏感檔案清單
 */
export const SENSITIVE_CRYPTO_FILES = [
  "apps/worker/src/platform/crypto.ts",
  "apps/worker/src/platform/access-auth.ts",
  "apps/worker/src/middleware/access.ts",
];

/**
 * 關鍵加密參數與敏感關鍵字
 */
export const SENSITIVE_CRYPTO_KEYWORDS = [
  "CONFIG_ENCRYPTION_KEY",
  "AES-GCM",
  "crypto.subtle",
];

/**
 * 檢查 hostname 是否符合核准的白名單規則
 */
export function isApprovedDomain(hostname) {
  if (!hostname || typeof hostname !== "string") return false;
  const lowerHost = hostname.trim().toLowerCase();

  for (const pattern of APPROVED_DOMAINS) {
    if (pattern.startsWith("*.")) {
      const baseDomain = pattern.slice(2).toLowerCase();
      if (lowerHost === baseDomain || lowerHost.endsWith("." + baseDomain)) {
        return true;
      }
    } else {
      if (lowerHost === pattern.toLowerCase()) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 解析 unified diff 字串，依檔案提取新增的程式碼行
 */
export function parseUnifiedDiff(diffText) {
  const fileDiffs = [];
  if (!diffText || typeof diffText !== "string") return fileDiffs;

  const rawBlocks = diffText.split(/^diff --git /m);
  for (const block of rawBlocks) {
    if (!block.trim()) continue;

    let filePath = "";
    const plusMatch = block.match(/^\+\+\+\s+b\/(.+)$/m);
    if (plusMatch) {
      filePath = plusMatch[1].trim();
    } else {
      const headerMatch = block.match(/^a\/(.+?)\s+b\/(.+?)$/m);
      if (headerMatch) {
        filePath = headerMatch[2].trim();
      }
    }

    const addedLines = [];
    const lines = block.split("\n");
    let currentLineNum = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentLineNum = parseInt(hunkMatch[1], 10);
        continue;
      }

      if (line.startsWith("+") && !line.startsWith("+++")) {
        addedLines.push({
          content: line.slice(1),
          raw: line,
          lineNumber: currentLineNum,
        });
        currentLineNum++;
      } else if (!line.startsWith("-")) {
        currentLineNum++;
      }
    }

    fileDiffs.push({
      filePath: filePath.replace(/\\/g, "/"),
      rawBlock: block,
      addedLines,
    });
  }

  return fileDiffs;
}

/**
 * 遮蔽敏感資訊以避免報告外洩
 */
export function maskSecret(secret) {
  if (!secret || typeof secret !== "string") return "******";
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "******";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * 規則 1: 外部連線外洩檢測 (Data Exfiltration)
 */
export function scanDataExfiltration(fileDiffs) {
  const findings = [];
  const urlRegex = /https?:\/\/[^\s"'`<>)]+/gi;
  const triggerRegex = /\b(?:fetch|new\s+WebSocket|axios)\b|https?:\/\//i;

  for (const file of fileDiffs) {
    if (
      file.filePath.endsWith(".md") ||
      file.filePath.endsWith(".txt") ||
      file.filePath.endsWith("scripts/review-pr-security.mjs") ||
      file.filePath.startsWith("deploy/taiwan-relay/")
    ) {
      continue;
    }
    for (const line of file.addedLines) {
      if (!triggerRegex.test(line.content)) continue;

      // 檢查是否含有 URL
      const foundUrls = line.content.match(urlRegex) || [];
      for (const urlStr of foundUrls) {
        // 清理結尾標點符號
        const cleanUrl = urlStr.replace(/[;,.)'"`]+$/, "");
        try {
          const parsed = new URL(cleanUrl);
          if (!isApprovedDomain(parsed.hostname)) {
            findings.push({
              rule: "外部連線外洩檢測 (Data Exfiltration)",
              level: "HIGH",
              file: file.filePath,
              lineNumber: line.lineNumber,
              message: `新增未核准的外部連線位址: ${cleanUrl}`,
              snippet: line.content.trim(),
            });
          }
        } catch {
          // 若無法解析成標準 URL，但含 http 協定
          findings.push({
            rule: "外部連線外洩檢測 (Data Exfiltration)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: `新增異常或格式不符之外部連線位址: ${cleanUrl}`,
            snippet: line.content.trim(),
          });
        }
      }

      // 檢查 WebSocket 連線
      if (/new\s+WebSocket\s*\(/i.test(line.content)) {
        const wsMatch = line.content.match(/wss?:\/\/[^\s"'`<>)]+/i);
        if (wsMatch) {
          const wsUrl = wsMatch[0].replace(/[;,.)'"`]+$/, "");
          try {
            const parsed = new URL(wsUrl);
            if (!isApprovedDomain(parsed.hostname)) {
              findings.push({
                rule: "外部連線外洩檢測 (Data Exfiltration)",
                level: "HIGH",
                file: file.filePath,
                lineNumber: line.lineNumber,
                message: `新增未核准的 WebSocket 外部連線: ${wsUrl}`,
                snippet: line.content.trim(),
              });
            }
          } catch {
            findings.push({
              rule: "外部連線外洩檢測 (Data Exfiltration)",
              level: "HIGH",
              file: file.filePath,
              lineNumber: line.lineNumber,
              message: `新增格式異常之 WebSocket 連線: ${wsUrl}`,
              snippet: line.content.trim(),
            });
          }
        } else if (foundUrls.length === 0) {
          // 動態 WebSocket 連線 (無明確字面網址)
          findings.push({
            rule: "外部連線外洩檢測 (Data Exfiltration)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: `偵測到動態目標的 WebSocket 連線建立`,
            snippet: line.content.trim(),
          });
        }
      }

      // 檢查動態 fetch / axios 外部呼叫（排除相對路徑字串及方法宣告）
      const isMethodDecl = /^\s*(?:async\s+)?fetch\s*\([^)]*\)\s*\{/i.test(
        line.content,
      );
      if (
        !isMethodDecl &&
        /\b(?:fetch|axios(?:\.[a-z]+)?)\s*\(/i.test(line.content)
      ) {
        if (foundUrls.length === 0) {
          const isRelativePathCall =
            /\b(?:fetch|axios(?:\.[a-z]+)?)\s*\(\s*["'`]\/[^"'`]*["'`]/i.test(
              line.content,
            );
          if (!isRelativePathCall) {
            findings.push({
              rule: "外部連線外洩檢測 (Data Exfiltration)",
              level: "HIGH",
              file: file.filePath,
              lineNumber: line.lineNumber,
              message: `偵測到非相對路徑之外部連線呼叫 (fetch / axios)`,
              snippet: line.content.trim(),
            });
          }
        }
      }
    }
  }

  return findings;
}

/**
 * 規則 2: 加密與金鑰完整性檢測 (Crypto & Key Integrity)
 */
export function scanCryptoAndKeyIntegrity(changedFiles, fileDiffs) {
  const findings = [];
  const normalizedChanged = changedFiles.map((f) =>
    f.trim().replace(/\\/g, "/"),
  );

  // 1. 檢查核心安全性敏感檔案變更
  for (const sensitiveFile of SENSITIVE_CRYPTO_FILES) {
    if (
      normalizedChanged.some(
        (f) => f === sensitiveFile || f.endsWith("/" + sensitiveFile),
      )
    ) {
      findings.push({
        rule: "加密與金鑰完整性檢測 (Crypto & Key Integrity)",
        level: "HIGH",
        file: sensitiveFile,
        message: `核心安全性或加密模組檔案遭修改: ${sensitiveFile}`,
      });
    }
  }

  // 2. 檢查程式碼中是否修改或新增關鍵加密參數/API
  for (const file of fileDiffs) {
    if (file.filePath.endsWith(".md") || file.filePath.endsWith(".txt")) {
      continue;
    }
    for (const line of file.addedLines) {
      for (const kw of SENSITIVE_CRYPTO_KEYWORDS) {
        if (line.content.includes(kw)) {
          findings.push({
            rule: "加密與金鑰完整性檢測 (Crypto & Key Integrity)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: `偵測到涉及關鍵加密參數或 API 的變更: ${kw}`,
            snippet: line.content.trim(),
          });
        }
      }
    }
  }

  return findings;
}

/**
 * 規則 3: CI/CD 工作流程安全檢測 (Workflow & Permissions Security)
 */
export function scanWorkflowSecurity(fileDiffs) {
  const findings = [];

  for (const file of fileDiffs) {
    const isWorkflow =
      file.filePath.startsWith(".github/workflows/") ||
      file.filePath.includes("/.github/workflows/");
    if (!isWorkflow) continue;

    for (const line of file.addedLines) {
      const trimmed = line.content.trim();

      // 檢查 permissions:
      if (/^\s*permissions\s*:/i.test(line.content)) {
        if (!file.filePath.endsWith(".github/workflows/pr-review.yml")) {
          findings.push({
            rule: "CI/CD 工作流程安全檢測 (Workflow & Permissions Security)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: "工作流程中新增 permissions 定義，可能涉及權限擴大",
            snippet: trimmed,
          });
        }
      }

      // 檢查 id-token: write
      if (/id-token\s*:\s*write/i.test(line.content)) {
        findings.push({
          rule: "CI/CD 工作流程安全檢測 (Workflow & Permissions Security)",
          level: "HIGH",
          file: file.filePath,
          lineNumber: line.lineNumber,
          message:
            "工作流程中新增 id-token: write 權限，存在 OIDC 憑據洩漏風險",
          snippet: trimmed,
        });
      }

      // 檢查 curl | bash 或 wget | bash
      if (/(?:curl|wget)\s+[^|\n]+?\|\s*(?:ba)?sh\b/i.test(line.content)) {
        findings.push({
          rule: "CI/CD 工作流程安全檢測 (Workflow & Permissions Security)",
          level: "HIGH",
          file: file.filePath,
          lineNumber: line.lineNumber,
          message:
            "工作流程中偵測到危險指令管線執行 (curl | bash / wget | bash)",
          snippet: trimmed,
        });
      }

      // 檢查未鎖定 commit SHA 的 GitHub Action
      const usesMatch = line.content.match(
        /^\s*uses\s*:\s*([a-zA-Z0-9_\-\.\/]+)@([^\s#]+)/i,
      );
      if (usesMatch) {
        const actionName = usesMatch[1];
        const actionRef = usesMatch[2];
        const isLocalAction = actionName.startsWith("./");
        const isShaPinned = /^[0-9a-f]{40}$/i.test(actionRef);

        if (!isLocalAction && !isShaPinned) {
          findings.push({
            rule: "CI/CD 工作流程安全檢測 (Workflow & Permissions Security)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: `工作流程中使用未鎖定完整 Commit SHA 的 Action: ${actionName}@${actionRef}`,
            snippet: trimmed,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * 規則 4: 敏感資訊硬編碼檢測 (Hardcoded Secrets)
 */
export function scanHardcodedSecrets(fileDiffs) {
  const findings = [];

  const secretPatterns = [
    {
      name: "Private Key",
      regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/,
      desc: "偵測到硬編碼的私鑰 (Private Key)",
    },
    {
      name: "AWS Access Key",
      regex: /\b(AKIA[0-9A-Z]{16})\b/,
      desc: "偵測到硬編碼的 AWS Access Key",
    },
    {
      name: "GitHub Token",
      regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/,
      desc: "偵測到硬編碼的 GitHub Token",
    },
    {
      name: "Slack Token",
      regex: /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/,
      desc: "偵測到硬編碼的 Slack Token",
    },
  ];

  const genericSecretRegex =
    /(?:api[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']([^"'\s]{10,})["']/i;
  const genericPasswordRegex =
    /(?:password|passwd|pwd)\s*[:=]\s*["']([^"'\s]{8,})["']/i;

  const isPlaceholder = (val) => {
    if (!val) return true;
    const lower = val.toLowerCase();
    return (
      lower.includes("placeholder") ||
      lower.includes("dummy") ||
      lower.includes("example") ||
      lower.includes("test_") ||
      lower.includes("mock_") ||
      lower.includes("your-") ||
      lower.includes("todo") ||
      lower.includes("change_me") ||
      /^[*.]+$/.test(val) ||
      val === "password" ||
      val === "12345678"
    );
  };

  for (const file of fileDiffs) {
    for (const line of file.addedLines) {
      // 1. 特徵已知之 Token / Key 模式
      for (const pattern of secretPatterns) {
        const match = line.content.match(pattern.regex);
        if (match) {
          findings.push({
            rule: "敏感資訊硬編碼檢測 (Hardcoded Secrets)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: pattern.desc,
            snippet: maskSecret(line.content.trim()),
          });
        }
      }

      // 2. 通用 API Key / Secret 變數賦值
      const secretMatch = line.content.match(genericSecretRegex);
      if (secretMatch) {
        const value = secretMatch[1];
        if (!isPlaceholder(value)) {
          findings.push({
            rule: "敏感資訊硬編碼檢測 (Hardcoded Secrets)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: `偵測到疑似硬編碼的 API 金鑰或存取憑據 (${maskSecret(value)})`,
            snippet: maskSecret(line.content.trim()),
          });
        }
      }

      // 3. 通用密碼賦值
      const pwdMatch = line.content.match(genericPasswordRegex);
      if (pwdMatch) {
        const value = pwdMatch[1];
        if (!isPlaceholder(value)) {
          findings.push({
            rule: "敏感資訊硬編碼檢測 (Hardcoded Secrets)",
            level: "HIGH",
            file: file.filePath,
            lineNumber: line.lineNumber,
            message: `偵測到疑似硬編碼的密碼 (${maskSecret(value)})`,
            snippet: maskSecret(line.content.trim()),
          });
        }
      }
    }
  }

  return findings;
}

/**
 * 整合所有安全規則掃描
 */
export function scanSecurityRules({ changedFiles = [], diffText = "" }) {
  const fileDiffs = parseUnifiedDiff(diffText);

  const findings = [
    ...scanDataExfiltration(fileDiffs),
    ...scanCryptoAndKeyIntegrity(changedFiles, fileDiffs),
    ...scanWorkflowSecurity(fileDiffs),
    ...scanHardcodedSecrets(fileDiffs),
  ];

  const normalizedChanged = changedFiles.map((f) =>
    f.trim().replace(/\\/g, "/"),
  );
  const sensitiveFiles = SENSITIVE_CRYPTO_FILES.filter((sf) =>
    normalizedChanged.some((f) => f === sf || f.endsWith("/" + sf)),
  );

  const highRiskCount = findings.filter((f) => f.level === "HIGH").length;
  const warningCount = findings.filter((f) => f.level === "WARNING").length;

  let overallRating = "PASS";
  let overallRatingText = "🟢 通過 (無高風險)";

  if (highRiskCount > 0) {
    overallRating = "ALERT";
    overallRatingText = "🔴 警報 (發現高風險項目)";
  } else if (warningCount > 0) {
    overallRating = "WARNING";
    overallRatingText = "🟡 注意 (有警告)";
  }

  return {
    overallRating,
    overallRatingText,
    summary: {
      totalFiles: changedFiles.length,
      sensitiveFilesCount: sensitiveFiles.length,
      highRiskCount,
      warningCount,
    },
    sensitiveFiles,
    findings,
  };
}

/**
 * 產生正體中文 Markdown 安全審查報告
 */
export function generateSecurityReport({
  prNumber,
  scanResults,
  aiReviewText,
  changedFiles = [],
}) {
  const title = prNumber
    ? `# 🛡️ OpenCode 自動安全審查報告 (PR #${prNumber})`
    : `# 🛡️ OpenCode 自動安全審查報告`;

  const { overallRatingText, sensitiveFiles, findings, summary } = scanResults;

  // 1. 變更統計與敏感檔案追蹤
  let sensitiveSection = "- 敏感檔案追蹤: 未變更核心安全性或加密模組檔案";
  if (sensitiveFiles && sensitiveFiles.length > 0) {
    sensitiveSection =
      "- 敏感檔案追蹤:\n" +
      sensitiveFiles
        .map((f) => `  - \`${f}\` (⚠️ 核心安全性/加密模組)`)
        .join("\n");
  }

  const section1 = `## 1. 變更統計與敏感檔案追蹤\n- 變更檔案總數: ${summary.totalFiles} 個\n${sensitiveSection}`;

  // 2. 靜態規則掃描結果
  let section2 = "## 2. 靜態規則掃描結果\n";
  const highRisks = findings.filter((f) => f.level === "HIGH");
  const warnings = findings.filter((f) => f.level === "WARNING");

  if (highRisks.length === 0 && warnings.length === 0) {
    section2 +=
      "### ✅ 未檢測到高風險或警告項目\n所有靜態安全規則檢測皆已通過，未發現異常外部連線、金鑰竄改、工作流程提升或硬編碼憑據。";
  } else {
    if (highRisks.length > 0) {
      section2 += `### 🔴 高風險項目 (${highRisks.length} 項)\n`;
      highRisks.forEach((item, index) => {
        section2 += `${index + 1}. **[${item.rule}]** 檔案 \`${item.file}\`${item.lineNumber ? ` (第 ${item.lineNumber} 行)` : ""}:\n`;
        section2 += `   - **說明**: ${item.message}\n`;
        if (item.snippet) {
          section2 += `   - **程式碼片段**: \`${item.snippet}\`\n`;
        }
      });
      section2 += "\n";
    }

    if (warnings.length > 0) {
      section2 += `### 🟡 警告項目 (${warnings.length} 項)\n`;
      warnings.forEach((item, index) => {
        section2 += `${index + 1}. **[${item.rule}]** 檔案 \`${item.file}\`${item.lineNumber ? ` (第 ${item.lineNumber} 行)` : ""}:\n`;
        section2 += `   - **說明**: ${item.message}\n`;
        if (item.snippet) {
          section2 += `   - **程式碼片段**: \`${item.snippet}\`\n`;
        }
      });
      section2 += "\n";
    }
  }

  // 3. 安全建議與注意事項
  let section3 = "## 3. 安全建議與注意事項\n";
  if (highRisks.length > 0) {
    const rulesTriggered = new Set(highRisks.map((f) => f.rule));
    if (rulesTriggered.has("外部連線外洩檢測 (Data Exfiltration)")) {
      section3 +=
        "- 🌐 **外部連線外洩風險**: 偵測到新增未核准的外部網址或動態請求。請確認該連線是否為官方或業務必要服務；如為合法端點，請提交白名單更新，並切勿向外部傳送使用者未去識別化機敏資料。\n";
    }
    if (rulesTriggered.has("加密與金鑰完整性檢測 (Crypto & Key Integrity)")) {
      section3 +=
        "- 🔐 **核心加密與金鑰完整性**: 涉及核心加密檔案或關鍵參數變更，請務必由資安架構人員進行雙人審查 (Peer Review)，確保加密演算法 (AES-GCM) 與金鑰強度符合標準。\n";
    }
    if (
      rulesTriggered.has(
        "CI/CD 工作流程安全檢測 (Workflow & Permissions Security)",
      )
    ) {
      section3 +=
        "- ⚙️ **CI/CD 工作流程風險**: 請落實最小權限原則，嚴禁使用 `curl | bash` 等動態下載執行指令，並使用完整的 40 碼 Commit SHA 鎖定第三方 Actions 以防範供應鏈攻擊。\n";
    }
    if (rulesTriggered.has("敏感資訊硬編碼檢測 (Hardcoded Secrets)")) {
      section3 +=
        "- 🔑 **機密資訊暴露**: 程式碼中疑似包含明文金鑰、私鑰或密碼。請立即將該憑據吊銷重發，並改用環境變數或 Cloudflare Worker Secrets 注入。\n";
    }
  } else {
    section3 +=
      "- ✅ 本次變更未觸發靜態高風險規則。\n- 建議於合併前完成各端單元測試、型別檢查與端對端整合驗收流程。\n";
  }

  // 4. AI 智能安全深度分析
  let section4 = "";
  if (aiReviewText) {
    section4 = `\n## 4. AI 智能安全深度分析\n${aiReviewText}\n`;
  }

  return `${title}\n\n**總體安全評級**: ${overallRatingText}\n\n${section1}\n\n${section2}\n\n${section3}${section4}`.trim();
}

/**
 * 檢查 AI 模型工具或金鑰是否可用
 */
export function isAiAvailable() {
  if (process.env.SKIP_AI_REVIEW === "true") return false;
  if (
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.DEEPSEEK_API_KEY
  )
    return true;

  try {
    const bin = process.env.OPENCODE_BIN || "opencode";
    const isNodeScript = bin.endsWith(".js") || bin.endsWith(".mjs");
    const cmd = isNodeScript ? process.execPath : bin;
    const args = isNodeScript ? [bin, "--version"] : ["--version"];

    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 3000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 格式化 AI 回應，自動處理推理模型（如 DeepSeek-R1 / deepseek-reasoner）與普通聊天模型（deepseek-chat）的差異：
 * 1. 支援提取 message.reasoning_content 並以可折疊的 <details> 標籤呈現。
 * 2. 支援解析文字中的 <think>...</think> 思考標籤並轉為折疊區塊。
 * 3. 確保最終審查結論與思考過程清晰分離，避免 PR 留言被大段思考過程淹沒。
 */
export function formatAiResponse(input) {
  if (!input) return null;

  if (typeof input === "object" && input !== null) {
    const content = String(input.content || "").trim();
    const reasoning = String(input.reasoning_content || "").trim();

    if (reasoning && content) {
      return `<details>\n<summary>💭 展開 DeepSeek 推理思考過程 (Reasoning Process)</summary>\n\n${reasoning}\n\n</details>\n\n${content}`;
    }
    if (content) return content;
    if (reasoning) return reasoning;
    return null;
  }

  const text = String(input).trim();
  if (!text) return null;

  // 處理 CLI 或第三方代理輸出的 <think>...</think> 標籤
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    const reasoning = thinkMatch[1].trim();
    const cleanContent = text.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
    if (reasoning && cleanContent) {
      return `<details>\n<summary>💭 展開 DeepSeek 推理思考過程 (Reasoning Process)</summary>\n\n${reasoning}\n\n</details>\n\n${cleanContent}`;
    }
    if (cleanContent) return cleanContent;
  }

  return text;
}

/**
 * 執行 AI 安全審查分析
 */
export async function runAiReview(diffText, options = {}) {
  const runner = options.runner;
  const prompt =
    "請以資安專家的角度審查以下 PR diff，分析是否有後門、機密外洩或架構弱點：\n\n";
  const truncatedDiff =
    diffText.length > 8000
      ? diffText.slice(0, 8000) + "\n\n...(diff 過長已截斷)..."
      : diffText;
  const fullMessage = prompt + truncatedDiff;

  if (runner) {
    return runner(fullMessage, options);
  }

  const timeoutMs = options.timeoutMs || 30000;
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();

  // 1. 第一優先：若配置了 OPENAI_API_KEY，透過 OpenAI 規範調用（支援 Opencode Provider、自訂 Endpoint 或 DeepSeek 轉發）
  if (openaiKey) {
    try {
      const isDeepseek =
        process.env.OPENAI_MODEL?.toLowerCase().includes("deepseek") ||
        process.env.OPENAI_BASE_URL?.toLowerCase().includes("deepseek");
      const endpoint =
        process.env.OPENAI_BASE_URL?.trim() ||
        (isDeepseek ? "https://api.deepseek.com" : "https://api.openai.com/v1");
      const defaultModel =
        process.env.OPENAI_MODEL ||
        process.env.OPENCODE_MODEL ||
        (isDeepseek ? "deepseek-chat" : "gpt-4o-mini");
      const isReasoner =
        defaultModel.includes("reasoner") ||
        defaultModel.includes("deepseek-r1");

      const bodyPayload = {
        model: defaultModel,
        messages: [
          {
            role: "system",
            content:
              "你是一名資安架構專家。請以正體中文審查 Pull Request 的代碼變更，分析是否有資料外洩、未授權連線、加密竄改、後門或架構弱點，並提供具體建議。",
          },
          { role: "user", content: fullMessage },
        ],
      };
      if (!isReasoner) {
        bodyPayload.temperature = 0.2;
      }

      const response = await fetch(
        `${endpoint.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
          },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.ok) {
        const data = await response.json();
        const formatted = formatAiResponse(data.choices?.[0]?.message);
        if (formatted) return formatted;
      }
    } catch {
      // 遇到異常時降級嘗試其他方式
    }
  }

  // 2. 第二優先：若配置了 GEMINI_API_KEY，透過 Gemini API 調用
  if (geminiKey) {
    try {
      const geminiModel =
        process.env.GEMINI_MODEL ||
        process.env.OPENCODE_MODEL ||
        "gemini-2.5-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullMessage }] }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        const data = await response.json();
        const formatted = formatAiResponse(
          data.candidates?.[0]?.content?.parts?.[0]?.text,
        );
        if (formatted) return formatted;
      }
    } catch {
      // 遇到異常時降級
    }
  }

  // 3. 第三優先：若配置了 DEEPSEEK_API_KEY，調用 DeepSeek 官方 API
  if (deepseekKey) {
    try {
      const endpoint =
        process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
      const model =
        process.env.DEEPSEEK_MODEL ||
        process.env.OPENCODE_MODEL ||
        "deepseek-chat";
      const isReasoner =
        model.includes("reasoner") || model.includes("deepseek-r1");

      const bodyPayload = {
        model,
        messages: [
          {
            role: "system",
            content:
              "你是一名資安架構專家。請以正體中文審查 Pull Request 的代碼變更，分析是否有資料外洩、未授權連線、加密竄改、後門或架構弱點，並提供具體建議。",
          },
          { role: "user", content: fullMessage },
        ],
      };
      // deepseek-reasoner 不支援自訂 temperature 參數
      if (!isReasoner) {
        bodyPayload.temperature = 0.2;
      }

      const response = await fetch(
        `${endpoint.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${deepseekKey}`,
          },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.ok) {
        const data = await response.json();
        const formatted = formatAiResponse(data.choices?.[0]?.message);
        if (formatted) return formatted;
      }
    } catch {
      // 遇異常降級嘗試其他方式
    }
  }

  // 4. 嘗試呼叫本地 opencode CLI
  const bin = process.env.OPENCODE_BIN || "opencode";
  const isNodeScript = bin.endsWith(".js") || bin.endsWith(".mjs");
  const cmd = isNodeScript ? process.execPath : bin;

  try {
    const modelArg = process.env.OPENCODE_MODEL
      ? ["-m", process.env.OPENCODE_MODEL]
      : [];
    const args = isNodeScript
      ? [bin, "run", "--pure", ...modelArg, fullMessage]
      : ["run", "--pure", ...modelArg, fullMessage];

    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: options.env || process.env,
    });

    if (result.error || result.status !== 0) {
      return null;
    }

    return formatAiResponse(result.stdout?.trim()) || null;
  } catch {
    return null;
  }
}

/**
 * 解析 Git Base Ref
 */
export function resolveBaseRef(requestedBase, options = {}) {
  if (requestedBase) return requestedBase;
  const runner = options.runner || spawnSync;
  const cwd = options.cwd || process.cwd();

  const originMainCheck = runner(
    "git",
    ["rev-parse", "--verify", "origin/main"],
    {
      encoding: "utf8",
      cwd,
    },
  );
  if (originMainCheck.status === 0) return "origin/main";

  const mainCheck = runner("git", ["rev-parse", "--verify", "main"], {
    encoding: "utf8",
    cwd,
  });
  if (mainCheck.status === 0) return "main";

  return "HEAD~1";
}

/**
 * 取得 Git 比對資訊 (name-only 及 unified diff -U5)
 */
export function getGitDiff(baseRef, headRef = "HEAD", options = {}) {
  const runner = options.runner || spawnSync;
  const cwd = options.cwd || process.cwd();

  const nameOnlyResult = runner(
    "git",
    ["diff", "--name-only", `${baseRef}...${headRef}`],
    {
      encoding: "utf8",
      cwd,
    },
  );

  if (nameOnlyResult.error || nameOnlyResult.status !== 0) {
    const err =
      nameOnlyResult.stderr || nameOnlyResult.error?.message || "未知錯誤";
    throw new Error(
      `無法執行 git diff --name-only ${baseRef}...${headRef}：${err}`,
    );
  }

  const changedFiles = nameOnlyResult.stdout
    .split("\n")
    .map((s) => s.trim().replace(/\\/g, "/"))
    .filter(Boolean);

  const diffResult = runner("git", ["diff", "-U5", `${baseRef}...${headRef}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    cwd,
  });

  if (diffResult.error || diffResult.status !== 0) {
    const err = diffResult.stderr || diffResult.error?.message || "未知錯誤";
    throw new Error(`無法執行 git diff -U5 ${baseRef}...${headRef}：${err}`);
  }

  const diffText = diffResult.stdout || "";
  return { changedFiles, diffText };
}

/**
 * 檢查 gh CLI 是否可用
 */
export function isGhAvailable(options = {}) {
  try {
    const runner = options.runner || spawnSync;
    const ghBin = process.env.GH_BIN?.trim() || "gh";
    const isNodeScript = ghBin.endsWith(".js") || ghBin.endsWith(".mjs");
    const cmd = isNodeScript ? process.execPath : ghBin;
    const args = isNodeScript ? [ghBin, "--version"] : ["--version"];

    const result = runner(cmd, args, {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 呼叫 gh CLI 於 PR 發表審查留言
 */
export function postPrComment(prNumber, commentBody, options = {}) {
  const runner = options.runner || spawnSync;
  const ghBin = process.env.GH_BIN?.trim() || "gh";
  const tempFile = path.join(
    tmpdir(),
    `pr-security-review-${prNumber}-${Date.now()}.md`,
  );
  writeFileSync(tempFile, commentBody, "utf8");

  try {
    const isNodeScript = ghBin.endsWith(".js") || ghBin.endsWith(".mjs");
    const cmd = isNodeScript ? process.execPath : ghBin;
    const args = isNodeScript
      ? [ghBin, "pr", "comment", String(prNumber), "--body-file", tempFile]
      : ["pr", "comment", String(prNumber), "--body-file", tempFile];

    const result = runner(cmd, args, {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      env: options.env || process.env,
    });

    if (result.error || result.status !== 0) {
      const err = result.stderr || result.error?.message || "";
      throw new Error(`gh pr comment 執行失敗 (PR #${prNumber})：\n${err}`);
    }

    return result;
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // 忽略暫存檔刪除錯誤
    }
  }
}

/**
 * 解析 CLI 參數
 */
export function parseCliArgs(args) {
  const options = {
    pr: {
      type: "string",
    },
    base: {
      type: "string",
    },
    head: {
      type: "string",
      default: "HEAD",
    },
    "dry-run": {
      type: "boolean",
      default: false,
    },
    "no-ai": {
      type: "boolean",
      default: false,
    },
    ai: {
      type: "boolean",
      default: false,
    },
  };

  const { values } = parseArgs({
    args,
    options,
    strict: false,
    allowPositionals: true,
  });

  return {
    pr: values.pr ? String(values.pr) : undefined,
    base: values.base,
    head: values.head || "HEAD",
    dryRun: Boolean(values["dry-run"]),
    noAi: Boolean(values["no-ai"]),
    enableAi: values.ai === true,
  };
}

/**
 * 主要執行函式
 */
export async function runSecurityReview(
  cliArgs = process.argv.slice(2),
  opts = {},
) {
  const config = parseCliArgs(cliArgs);
  const baseRef = resolveBaseRef(config.base, opts);
  const headRef = config.head || "HEAD";

  console.log(`🔍 正在比對分支差異 (${baseRef}...${headRef})...`);
  const { changedFiles, diffText } = getGitDiff(baseRef, headRef, opts);

  console.log(`📋 掃描靜態安全規則 (共變更 ${changedFiles.length} 個檔案)...`);
  const scanResults = scanSecurityRules({ changedFiles, diffText });

  let aiReviewText = null;
  const shouldRunAi =
    !config.noAi &&
    (config.enableAi ||
      process.env.ENABLE_AI_REVIEW === "true" ||
      isAiAvailable());

  if (shouldRunAi && !opts.skipAi) {
    console.log("🤖 正在執行 AI 安全深度審查...");
    try {
      aiReviewText = await runAiReview(diffText, opts);
    } catch (err) {
      console.warn("⚠️ AI 審查執行異常，將以純靜態規則結果輸出：", err.message);
    }
  }

  const report = generateSecurityReport({
    prNumber: config.pr,
    scanResults,
    aiReviewText,
    changedFiles,
  });

  console.log("\n" + report + "\n");

  if (config.pr) {
    if (config.dryRun) {
      console.log(`[Dry Run] 略過 PR #${config.pr} 留言發布。`);
    } else {
      if (!isGhAvailable(opts)) {
        console.warn("⚠️ 系統未偵測到 gh CLI 或未登入，略過 PR 留言。");
      } else {
        console.log(`📤 正在留言至 PR #${config.pr}...`);
        postPrComment(config.pr, report, opts);
        console.log(`✅ 已成功發布安全審查報告至 PR #${config.pr}。`);
      }
    }
  }

  return {
    config,
    baseRef,
    headRef,
    scanResults,
    report,
  };
}

// 若直接以 node 執行此腳本
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runSecurityReview().catch((error) => {
    console.error(`❌ 安全審查失敗：${error.message}`);
    process.exitCode = 1;
  });
}
