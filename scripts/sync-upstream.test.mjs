import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./sync-upstream.mjs", import.meta.url),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

function write(repo, relativePath, contents) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function configureAuthor(repo) {
  git(repo, "config", "user.name", "sync-upstream-test");
  git(repo, "config", "user.email", "sync-upstream-test@example.com");
}

function commitAll(repo, message) {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function initializeRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  configureAuthor(repo);
}

function initializeBareRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--bare", "--initial-branch=main");
}

function pushMain(worktree, bareRepository) {
  git(worktree, "remote", "add", "origin", bareRepository);
  git(worktree, "push", "-u", "origin", "main");
}

function cloneRepository(bareRepository, destination) {
  run("git", ["clone", bareRepository, destination]);
  configureAuthor(destination);
}

function createUpstream(root, { includeSecondCommit = true } = {}) {
  const worktree = path.join(root, "upstream-worktree");
  const bare = path.join(root, "upstream.git");
  initializeRepository(worktree);
  write(worktree, "app.txt", "version 1\n");
  write(worktree, "removed-after-v1.txt", "remove me\n");
  write(worktree, ".github/workflows/sync-upstream.yml", "name: upstream v1\n");
  write(worktree, ".github/workflows/ci.yml", "name: upstream ci\n");
  const firstCommit = commitAll(worktree, "upstream v1");
  initializeBareRepository(bare);
  pushMain(worktree, bare);

  let latestCommit = firstCommit;
  if (includeSecondCommit) {
    write(worktree, "app.txt", "version 2\n");
    write(worktree, "new-in-v2.txt", "new\n");
    rmSync(path.join(worktree, "removed-after-v1.txt"));
    latestCommit = commitAll(worktree, "upstream v2");
    git(worktree, "push", "origin", "main");
  }

  return { bare, firstCommit, latestCommit, worktree };
}

function createImportedDeployment(root, upstream, options = {}) {
  const worktree = path.join(root, "deployment-worktree");
  const bare = path.join(root, "deployment.git");
  initializeRepository(worktree);

  if (options.unknownBaseline) {
    write(worktree, "app.txt", "not an upstream version\n");
  } else {
    write(worktree, "app.txt", "version 1\n");
    write(worktree, "removed-after-v1.txt", "remove me\n");
  }
  const rootCommit = commitAll(worktree, "Cloudflare source repo import");

  write(
    worktree,
    ".github/workflows/sync-upstream.yml",
    "name: manually installed updater\n",
  );
  const beforeSync = commitAll(worktree, "install updater workflow");

  if (options.userChange) {
    write(worktree, "user-change.txt", "keep me\n");
    commitAll(worktree, "user customization");
  }

  initializeBareRepository(bare);
  pushMain(worktree, bare);
  git(worktree, "remote", "add", "test-upstream", upstream.bare);

  return { bare, beforeSync, rootCommit, worktree };
}

function runUpdater(worktree, upstreamBare, options = {}) {
  return run(process.execPath, [scriptPath], {
    cwd: worktree,
    allowFailure: true,
    env: {
      ...process.env,
      SYNC_UPSTREAM_URL: upstreamBare,
      ...options.env,
    },
  });
}

function remoteBranch(worktree, branch) {
  return git(
    worktree,
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ).split("\t")[0];
}

function withTemporaryRepository(testFunction) {
  const root = mkdtempSync(path.join(tmpdir(), "taiwan-fin-hub-sync-test-"));
  try {
    testFunction(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("最新版保持 no-op，不建立備份 branch", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    const before = git(runner, "rev-parse", "HEAD");
    const result = runUpdater(runner, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(runner, "rev-parse", "HEAD"), before);
    assert.equal(remoteBranch(runner, "backup-before-first-upstream-sync"), "");
    assert.match(result.stdout, /目前已是最新版/);
  });
});

test("有共同祖先且落後時建立單一 parent 的三方同步 commit", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    write(upstream.worktree, "app.txt", "version 2\n");
    upstream.latestCommit = commitAll(upstream.worktree, "upstream v2");
    git(upstream.worktree, "push", "origin", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    write(
      runner,
      ".github/workflows/sync-upstream.yml",
      "name: deployment updater\n",
    );
    commitAll(runner, "keep deployment updater");
    git(runner, "push", "origin", "main");
    const result = runUpdater(runner, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(runner, "show", "HEAD:.github/workflows/sync-upstream.yml"),
      "name: deployment updater",
    );
    assert.equal(
      git(
        runner,
        "diff",
        "--name-only",
        "HEAD",
        "upstream/main",
        "--",
        ".",
        ":(exclude).github/workflows/**",
      ),
      "",
    );
    assert.equal(
      git(runner, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
      2,
    );
    assert.match(
      git(runner, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstream.latestCommit}`),
    );
    assert.equal(remoteBranch(runner, "backup-before-first-upstream-sync"), "");
    assert.match(result.stdout, /作為三方合併基準/);
  });
});

test("首次無共同祖先時驗證來源、建立備份並同步完整上游 tree", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      deployment.beforeSync,
    );
    assert.equal(
      git(
        deployment.worktree,
        "diff",
        "--name-only",
        "HEAD",
        "upstream/main",
        "--",
        ".",
        ":(exclude).github/workflows/**",
      ),
      "",
    );
    assert.equal(
      git(
        deployment.worktree,
        "show",
        "HEAD:.github/workflows/sync-upstream.yml",
      ),
      "name: manually installed updater",
    );
    assert.equal(
      git(deployment.worktree, "ls-files", ".github/workflows/ci.yml"),
      "",
    );
    assert.equal(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" ").length,
      2,
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstream.latestCommit}`),
    );
    assert.notEqual(
      run(
        "git",
        ["merge-base", "--is-ancestor", upstream.latestCommit, "HEAD"],
        { cwd: deployment.worktree, allowFailure: true },
      ).status,
      0,
    );
    assert.equal(
      git(deployment.worktree, "ls-files", "removed-after-v1.txt"),
      "",
    );
  });
});

test("首次版本已是最新時仍以 allow-empty commit 記錄上游 baseline", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const deployment = createImportedDeployment(root, upstream);
    const before = git(deployment.worktree, "rev-parse", "HEAD");
    const beforeTree = git(deployment.worktree, "rev-parse", "HEAD^{tree}");

    const result = runUpdater(deployment.worktree, upstream.bare);
    const after = git(deployment.worktree, "rev-parse", "HEAD");

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(after, before);
    assert.equal(
      git(deployment.worktree, "rev-parse", "HEAD^{tree}"),
      beforeTree,
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [after, before],
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstream.latestCommit}`),
    );
  });
});

test("首次同步會拒絕 workflows 以外的使用者修改且不 push", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream, {
      userChange: true,
    });
    const before = remoteBranch(deployment.worktree, "main");
    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /已有 \.github\/workflows 以外的程式碼變更/);
    assert.match(result.stderr, /user-change\.txt/);
    assert.equal(remoteBranch(deployment.worktree, "main"), before);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      "",
    );
  });
});

test("找不到相符上游基準時拒絕首次同步", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream, {
      unknownBaseline: true,
    });
    const before = remoteBranch(deployment.worktree, "main");
    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /無法對應任何上游版本/);
    assert.equal(remoteBranch(deployment.worktree, "main"), before);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      "",
    );
  });
});

test("既有首次同步備份 branch 不會被覆寫", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    git(
      deployment.worktree,
      "push",
      "origin",
      `${deployment.rootCommit}:refs/heads/backup-before-first-upstream-sync`,
    );

    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      deployment.rootCommit,
    );
    assert.match(result.stdout, /為避免覆寫既有備份/);
  });
});

test("首次接軌成功後重跑保持冪等", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const afterFirstSync = git(deployment.worktree, "rev-parse", "HEAD");

    const secondResult = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(secondResult.status, 0, secondResult.stderr);
    assert.equal(git(deployment.worktree, "rev-parse", "HEAD"), afterFirstSync);
    assert.equal(remoteBranch(deployment.worktree, "main"), afterFirstSync);
    assert.match(secondResult.stdout, /使用先前同步紀錄/);
    assert.match(secondResult.stdout, /目前已是最新版/);
  });
});

test("三方合併發生程式碼衝突時不改 working tree 且不 push", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    write(runner, "app.txt", "deployment change\n");
    const deploymentCommit = commitAll(runner, "deployment change");
    git(runner, "push", "origin", "main");

    write(upstream.worktree, "app.txt", "upstream change\n");
    commitAll(upstream.worktree, "upstream change");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(runner, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONFLICT|發生衝突/);
    assert.equal(remoteBranch(runner, "main"), deploymentCommit);
    assert.equal(git(runner, "rev-parse", "HEAD"), deploymentCommit);
    assert.equal(git(runner, "status", "--porcelain"), "");
  });
});

test("SYNC_CREATE_PR 遇程式碼衝突時建立待解衝突 Draft PR 且不動 main", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    write(runner, "app.txt", "deployment change\n");
    const deploymentCommit = commitAll(runner, "deployment change");
    git(runner, "push", "origin", "main");

    write(upstream.worktree, "app.txt", "upstream change\n");
    upstream.latestCommit = commitAll(upstream.worktree, "upstream change");
    git(upstream.worktree, "push", "origin", "main");

    const mockGhScript = path.join(root, "mock-gh.mjs");
    const callsLog = path.join(root, "gh-calls.json");
    const outputFile = path.join(root, "github-output.txt");
    writeFileSync(outputFile, "");
    writeFileSync(
      mockGhScript,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  console.log("gh version 2.0.0 (mock)");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/example/repo/pull/321");
  process.exit(0);
}
process.exit(0);
`,
    );

    const result = runUpdater(runner, upstream.bare, {
      env: {
        SYNC_CREATE_PR: "true",
        GH_BIN: mockGhScript,
        GITHUB_OUTPUT: outputFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const syncBranch = `sync/upstream-${upstream.latestCommit.slice(0, 10)}`;
    const pushed = remoteBranch(runner, syncBranch);
    const baselineCommit = git(runner, "rev-parse", `${deploymentCommit}^`);

    // main 與工作目錄都不會被更動；同步分支只含乾淨的上游程式碼。
    assert.equal(remoteBranch(runner, "main"), deploymentCommit);
    assert.equal(git(runner, "rev-parse", "HEAD"), deploymentCommit);
    assert.equal(git(runner, "status", "--porcelain"), "");
    assert.notEqual(pushed, deploymentCommit);
    assert.equal(git(runner, "show", `${pushed}:app.txt`), "upstream change");
    assert.doesNotMatch(git(runner, "show", `${pushed}:app.txt`), /<<<<<<</);
    assert.equal(git(runner, "merge-base", "main", pushed), baselineCommit);

    assert.equal(
      readFileSync(outputFile, "utf8"),
      "pr_number=321\npr_url=https://github.com/example/repo/pull/321\n",
    );

    const calls = readFileSync(callsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const prCreateCall = calls.find((c) => c[0] === "pr" && c[1] === "create");
    assert.ok(prCreateCall);
    assert.ok(prCreateCall.includes("--draft"));
    const titleIndex = prCreateCall.indexOf("--title") + 1;
    assert.match(prCreateCall[titleIndex], /\[待解衝突\]/);
    assert.match(
      prCreateCall[titleIndex],
      new RegExp(upstream.latestCommit.slice(0, 10)),
    );
    const bodyIndex = prCreateCall.indexOf("--body") + 1;
    assert.match(prCreateCall[bodyIndex], /app\.txt/);
    assert.match(prCreateCall[bodyIndex], /Resolve conflicts/);
    assert.doesNotMatch(prCreateCall[bodyIndex], /移除 <<<<<<</);
    assert.match(result.stdout, /衝突/);
  });
});

test("SYNC_CREATE_PR 過渡模式保留本地客製並注入純上游基準 commit", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });

    const runner = path.join(root, "runner");
    const originBare = path.join(root, "deployment.git");
    initializeRepository(runner);
    write(runner, "app.txt", "version 1\n");
    write(runner, "local-config.txt", "local config\n");
    git(runner, "add", "--all");
    git(runner, "commit", "-m", "Cloudflare source repo import");
    write(runner, "local-config.txt", "local name\n");
    git(runner, "commit", "-am", "local customization");
    git(
      runner,
      "commit",
      "--allow-empty",
      "-m",
      "chore(upstream): 同步上游版本 v1",
      "-m",
      `Taiwan-Fin-Hub-Upstream: ${upstream.firstCommit}`,
    );
    const localCommit = git(runner, "rev-parse", "HEAD");
    initializeBareRepository(originBare);
    pushMain(runner, originBare);

    write(upstream.worktree, "app.txt", "version 2\n");
    write(upstream.worktree, "local-config.txt", "upstream name\n");
    upstream.latestCommit = commitAll(upstream.worktree, "upstream v2");
    git(upstream.worktree, "push", "origin", "main");

    const mockGhScript = path.join(root, "mock-gh.mjs");
    const callsLog = path.join(root, "gh-calls.json");
    const outputFile = path.join(root, "github-output.txt");
    writeFileSync(outputFile, "");
    writeFileSync(
      mockGhScript,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  console.log("gh version 2.0.0 (mock)");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/example/repo/pull/654");
  process.exit(0);
}
process.exit(0);
`,
    );

    const result = runUpdater(runner, upstream.bare, {
      env: {
        SYNC_CREATE_PR: "true",
        GH_BIN: mockGhScript,
        GITHUB_OUTPUT: outputFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const syncBranch = `sync/upstream-${upstream.latestCommit.slice(0, 10)}`;
    const pushed = remoteBranch(runner, syncBranch);
    assert.notEqual(pushed, "");
    assert.equal(remoteBranch(runner, "main"), localCommit);

    // 過渡模式：分支保留本地客製，且沒有衝突標記。
    assert.equal(
      git(runner, "show", `${pushed}:local-config.txt`),
      "local name",
    );
    assert.equal(git(runner, "show", `${pushed}:app.txt`), "version 2");
    assert.doesNotMatch(
      git(runner, "show", `${pushed}:local-config.txt`),
      /<<<<<<</,
    );

    // 分支上包含純上游 tree 的基準 commit，parent 指向目前的 HEAD。
    const baselineRecord = git(runner, "rev-parse", `${pushed}^`);
    assert.equal(
      git(runner, "show", "-s", "--format=%T", baselineRecord),
      git(runner, "show", "-s", "--format=%T", upstream.latestCommit),
    );
    assert.equal(git(runner, "rev-parse", `${baselineRecord}^`), localCommit);

    const calls = readFileSync(callsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const prCreateCall = calls.find((c) => c[0] === "pr" && c[1] === "create");
    assert.ok(prCreateCall);
    assert.ok(!prCreateCall.includes("--draft"));
    const titleIndex = prCreateCall.indexOf("--title") + 1;
    assert.doesNotMatch(prCreateCall[titleIndex], /\[待解衝突\]/);
    const bodyIndex = prCreateCall.indexOf("--body") + 1;
    assert.match(prCreateCall[bodyIndex], /過渡基準/);
    assert.match(prCreateCall[bodyIndex], /local-config\.txt/);

    // 模擬合併 PR 後，下一次同步以基準 commit 為 merge base 並原生顯示衝突。
    git(runner, "merge", "--no-ff", "-m", "Merge sync PR", pushed);
    git(runner, "push", "origin", "main");
    write(upstream.worktree, "local-config.txt", "upstream name v3\n");
    upstream.latestCommit = commitAll(upstream.worktree, "upstream v3");
    git(upstream.worktree, "push", "origin", "main");
    writeFileSync(callsLog, "");

    const second = runUpdater(runner, upstream.bare, {
      env: {
        SYNC_CREATE_PR: "true",
        GH_BIN: mockGhScript,
        GITHUB_OUTPUT: outputFile,
      },
    });

    assert.equal(second.status, 0, second.stderr);
    const secondBranch = `sync/upstream-${upstream.latestCommit.slice(0, 10)}`;
    const secondPushed = remoteBranch(runner, secondBranch);
    assert.equal(
      git(runner, "merge-base", "main", secondPushed),
      baselineRecord,
    );
    assert.equal(
      git(runner, "show", `${secondPushed}:local-config.txt`),
      "upstream name v3",
    );
    assert.doesNotMatch(
      git(runner, "show", `${secondPushed}:local-config.txt`),
      /<<<<<<</,
    );
    const secondCalls = readFileSync(callsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const secondPrCall = secondCalls.find(
      (c) => c[0] === "pr" && c[1] === "create",
    );
    assert.ok(secondPrCall.includes("--draft"));
    const secondTitleIndex = secondPrCall.indexOf("--title") + 1;
    assert.match(secondPrCall[secondTitleIndex], /\[待解衝突\]/);
    const secondBodyIndex = secondPrCall.indexOf("--body") + 1;
    assert.match(secondPrCall[secondBodyIndex], /local-config\.txt/);
    assert.match(secondPrCall[secondBodyIndex], /Resolve conflicts/);
  });
});

test("gh 建立 PR 權限不足時輸出 GitHub Actions 設定指引", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);

    const mockGhScript = path.join(root, "mock-gh.mjs");
    writeFileSync(
      mockGhScript,
      `const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("gh version 2.0.0 (mock)");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  console.error(
    "pull request create failed: GraphQL: Resource not accessible by integration (createPullRequest)",
  );
  process.exit(1);
}
process.exit(0);
`,
    );

    const result = runUpdater(deployment.worktree, upstream.bare, {
      env: { SYNC_CREATE_PR: "true", GH_BIN: mockGhScript },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Resource not accessible by integration/);
    assert.match(
      result.stderr,
      /Allow GitHub Actions to create and approve pull requests/,
    );
  });
});

test("先前同步後的非衝突使用者修改會保留，且不引入上游 parent", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);

    write(deployment.worktree, "user-note.txt", "deployment note\n");
    const userCommit = commitAll(deployment.worktree, "user note");
    git(deployment.worktree, "push", "origin", "main");

    write(upstream.worktree, "upstream-v3.txt", "upstream v3\n");
    const upstreamV3 = commitAll(upstream.worktree, "upstream v3");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(deployment.worktree, "show", "HEAD:user-note.txt"),
      "deployment note",
    );
    assert.equal(
      git(deployment.worktree, "show", "HEAD:upstream-v3.txt"),
      "upstream v3",
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [git(deployment.worktree, "rev-parse", "HEAD"), userCommit],
    );
    assert.notEqual(
      run("git", ["merge-base", "--is-ancestor", upstreamV3, "HEAD"], {
        cwd: deployment.worktree,
        allowFailure: true,
      }).status,
      0,
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstreamV3}`),
    );
  });
});

test("只有上游 workflow 變更時以 allow-empty commit 更新 baseline", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const before = git(deployment.worktree, "rev-parse", "HEAD");
    const beforeTree = git(deployment.worktree, "rev-parse", "HEAD^{tree}");

    write(
      upstream.worktree,
      ".github/workflows/ci.yml",
      "name: upstream ci v2\n",
    );
    const workflowOnlyCommit = commitAll(upstream.worktree, "update workflow");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(deployment.worktree, upstream.bare);
    const after = git(deployment.worktree, "rev-parse", "HEAD");

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(after, before);
    assert.equal(
      git(deployment.worktree, "rev-parse", "HEAD^{tree}"),
      beforeTree,
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [after, before],
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${workflowOnlyCommit}`),
    );
    assert.match(result.stdout, /保留部署版本/);
  });
});

test("啟用 SYNC_CREATE_PR 時推送到 sync branch 並透過 gh 建立 PR 與輸出 GITHUB_OUTPUT", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);

    const mockGhScript = path.join(root, "mock-gh.mjs");
    const callsLog = path.join(root, "gh-calls.json");
    const outputFile = path.join(root, "github-output.txt");
    writeFileSync(outputFile, "");
    writeFileSync(
      mockGhScript,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  console.log("gh version 2.0.0 (mock)");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/example/repo/pull/123");
  process.exit(0);
}
process.exit(0);
`,
    );

    const result = runUpdater(deployment.worktree, upstream.bare, {
      env: {
        SYNC_CREATE_PR: "true",
        GH_BIN: mockGhScript,
        GITHUB_OUTPUT: outputFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const syncBranch = `sync/upstream-${upstream.latestCommit.slice(0, 10)}`;
    const pushed = remoteBranch(deployment.worktree, syncBranch);

    assert.equal(
      remoteBranch(deployment.worktree, "main"),
      deployment.beforeSync,
    );
    assert.equal(
      git(deployment.worktree, "rev-parse", "HEAD"),
      deployment.beforeSync,
    );
    assert.equal(
      git(deployment.worktree, "merge-base", "main", pushed),
      deployment.rootCommit,
    );
    assert.equal(
      git(deployment.worktree, "show", `${pushed}:app.txt`),
      "version 2",
    );
    assert.equal(
      git(deployment.worktree, "show", `${pushed}:new-in-v2.txt`),
      "new",
    );
    assert.equal(
      git(
        deployment.worktree,
        "show",
        `${pushed}:.github/workflows/sync-upstream.yml`,
      ),
      "name: manually installed updater",
    );
    assert.equal(
      git(
        deployment.worktree,
        "ls-tree",
        "--name-only",
        pushed,
        ".github/workflows/ci.yml",
      ),
      "",
    );
    assert.notEqual(
      run("git", ["cat-file", "-e", `${pushed}:removed-after-v1.txt`], {
        cwd: deployment.worktree,
        allowFailure: true,
      }).status,
      0,
    );

    assert.equal(
      readFileSync(outputFile, "utf8"),
      "pr_number=123\npr_url=https://github.com/example/repo/pull/123\n",
    );

    const calls = readFileSync(callsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const prListCall = calls.find((c) => c[0] === "pr" && c[1] === "list");
    assert.ok(prListCall);
    assert.ok(prListCall.includes("--head"));
    assert.ok(prListCall.includes(syncBranch));
    assert.ok(prListCall.includes("--json"));
    assert.ok(prListCall.includes("number,url"));

    const prCreateCall = calls.find((c) => c[0] === "pr" && c[1] === "create");
    assert.ok(prCreateCall);
    assert.ok(prCreateCall.includes("--base"));
    assert.ok(prCreateCall.includes("main"));
    assert.ok(prCreateCall.includes("--head"));
    assert.ok(prCreateCall.includes(syncBranch));
    assert.ok(prCreateCall.includes("--title"));
    assert.ok(
      prCreateCall.includes(
        `chore(upstream): 同步上游版本 ${upstream.latestCommit.slice(0, 10)}`,
      ),
    );
    assert.ok(prCreateCall.includes("--body"));
    const bodyIndex = prCreateCall.indexOf("--body") + 1;
    assert.match(prCreateCall[bodyIndex], /## 上游自動同步 PR/);
    assert.match(
      prCreateCall[bodyIndex],
      new RegExp(`上游 Commit: ${upstream.latestCommit}`),
    );
    assert.match(
      prCreateCall[bodyIndex],
      new RegExp(`基準 Commit: ${upstream.firstCommit}`),
    );
  });
});

test("啟用 SYNC_CREATE_PR 且已有 PR 時沿用既有 PR number 且不重複建立", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);

    const mockGhScript = path.join(root, "mock-gh.mjs");
    const callsLog = path.join(root, "gh-calls.json");
    const outputFile = path.join(root, "github-output.txt");
    writeFileSync(outputFile, "");
    writeFileSync(
      mockGhScript,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  console.log("gh version 2.0.0 (mock)");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  console.log(
    JSON.stringify([
      {
        number: 888,
        url: "https://github.com/example/repo/pull/888",
      },
    ]),
  );
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/example/repo/pull/999");
  process.exit(0);
}
process.exit(0);
`,
    );

    const result = runUpdater(deployment.worktree, upstream.bare, {
      env: {
        SYNC_CREATE_PR: "true",
        GH_BIN: mockGhScript,
        GITHUB_OUTPUT: outputFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const syncBranch = `sync/upstream-${upstream.latestCommit.slice(0, 10)}`;
    const pushed = remoteBranch(deployment.worktree, syncBranch);

    assert.equal(
      remoteBranch(deployment.worktree, "main"),
      deployment.beforeSync,
    );
    assert.equal(
      git(deployment.worktree, "rev-parse", "HEAD"),
      deployment.beforeSync,
    );
    assert.equal(
      git(deployment.worktree, "merge-base", "main", pushed),
      deployment.rootCommit,
    );

    assert.equal(
      readFileSync(outputFile, "utf8"),
      "pr_number=888\npr_url=https://github.com/example/repo/pull/888\n",
    );

    const calls = readFileSync(callsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const prListCall = calls.find((c) => c[0] === "pr" && c[1] === "list");
    assert.ok(prListCall);
    assert.ok(prListCall.includes("--head"));
    assert.ok(prListCall.includes(syncBranch));
    assert.ok(prListCall.includes("--json"));
    assert.ok(prListCall.includes("number,url"));

    const prCreateCall = calls.find((c) => c[0] === "pr" && c[1] === "create");
    assert.equal(prCreateCall, undefined);
  });
});
