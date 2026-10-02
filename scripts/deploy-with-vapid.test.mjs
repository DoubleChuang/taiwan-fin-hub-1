import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  deploy,
  ensureQueueExists,
  ensureRequiredQueues,
  readDeploymentConfig,
} from "./deploy-with-vapid.mjs";
import { isWorkersBuild } from "./prepare-cloudflare-build.mjs";

const queueName = "taiwan-fin-hub-sync";
const missingQueue = {
  exitCode: 1,
  stdout: "",
  stderr: `Queue "${queueName}" does not exist.`,
};

test("only prepares resources inside Cloudflare Workers Builds", () => {
  assert.equal(isWorkersBuild({ WORKERS_CI: "1" }), true);
  assert.equal(isWorkersBuild({ WORKERS_CI: undefined }), false);
});

test("Cloudflare build token reaches resource preparation, migrations and deployment without printing the token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloudflare-build-auth-"));
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const execute = promisify(execFile);
  const newToken = "synthetic token with spaces $() `quotes`";
  const cases = [
    {
      existing: newToken,
      expected: newToken,
    },
    { existing: "original-build-token", expected: "original-build-token" },
    {},
  ];
  const fixture = `#!${process.execPath}
import { basename } from "node:path";
console.log(JSON.stringify({
  command: basename(process.argv[1]),
  args: process.argv.slice(2),
  authorized: process.env.CLOUDFLARE_API_TOKEN === process.env.EXPECTED_TOKEN
}));
`;
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    for (const name of ["node", "npm"]) {
      await writeFile(join(directory, name), fixture, { mode: 0o700 });
    }
    for (const tokenCase of cases) {
      for (const name of ["prebuild", "deploy"]) {
        const { stdout, stderr } = await execute(
          "/bin/sh",
          ["-c", scripts[name]],
          {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH}`,
              CLOUDFLARE_API_TOKEN: tokenCase.existing,
              EXPECTED_TOKEN: tokenCase.expected,
            },
          },
        );
        const calls = stdout.trim().split("\n").map(JSON.parse);
        assert.ok(
          calls.every((call) => call.authorized),
          `${name}: wrong token`,
        );
        assert.deepEqual(
          calls.map(({ command, args }) => ({ command, args })),
          name === "prebuild"
            ? [
                {
                  command: "node",
                  args: ["scripts/prepare-cloudflare-build.mjs"],
                },
              ]
            : [
                { command: "npm", args: ["run", "db:migrate:remote"] },
                { command: "node", args: ["scripts/deploy-with-vapid.mjs"] },
              ],
        );
        assert.ok(!`${stdout}${stderr}`.includes(newToken));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runner(results, calls) {
  return async (argumentsToRun, options) => {
    calls.push({ argumentsToRun, options });
    const result = results.shift();
    assert.ok(result, "Unexpected Wrangler invocation");
    return result;
  };
}

test("keeps an existing Queue", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    ["--config", "wrangler.toml"],
    runner([{ exitCode: 0, stdout: "Queue Name", stderr: "" }], calls),
  );

  assert.deepEqual(
    calls.map((call) => call.argumentsToRun),
    [["queues", "info", queueName, "--config", "wrangler.toml"]],
  );
});

test("creates a missing Queue", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    [],
    runner(
      [missingQueue, { exitCode: 0, stdout: "Created", stderr: "" }],
      calls,
    ),
  );

  assert.deepEqual(
    calls.map((call) => call.argumentsToRun),
    [
      ["queues", "info", queueName],
      ["queues", "create", queueName],
    ],
  );
});

test("accepts a Queue created by a concurrent build", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    [],
    runner(
      [
        missingQueue,
        { exitCode: 1, stdout: "", stderr: "already exists" },
        { exitCode: 0, stdout: "Queue Name", stderr: "" },
      ],
      calls,
    ),
  );

  assert.equal(calls.length, 3);
});

test("reports a Queue creation failure", async () => {
  const calls = [];
  await assert.rejects(
    ensureQueueExists(
      queueName,
      [],
      runner(
        [
          missingQueue,
          { exitCode: 1, stdout: "", stderr: "permission denied" },
          missingQueue,
        ],
        calls,
      ),
    ),
    /Unable to create Queue.*permission denied/s,
  );
});

test("prepares the Queue names selected in the deployment config", async () => {
  const calls = [];
  await ensureRequiredQueues(
    [],
    runner([{ exitCode: 0, stdout: "Queue exists", stderr: "" }], calls),
    {
      queues: {
        producers: [{ binding: "SYNC_QUEUE", queue: "gui-selected-sync" }],
        consumers: [{ queue: "gui-selected-sync" }],
      },
    },
  );
  assert.deepEqual(
    calls.map(({ argumentsToRun }) => argumentsToRun),
    [["queues", "info", "gui-selected-sync"]],
  );
});

async function queueDeploymentFixture(
  t,
  queues,
  { namedEnvironment = false, failSecrets = false } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "queue-deployment-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "worker.toml");
  const queueSection = `[[queues.producers]]\nbinding = "SYNC_QUEUE"\nqueue = "${queueName}"\n[[queues.consumers]]\nqueue = "${queueName}"\nmax_batch_size = 1\nmax_concurrency = 1\n`;
  const source = `# Preserve the original config and its relative paths.\nname = "config-worker"\nmain = "src/index.ts"\ncompatibility_date = "2026-06-01"\nassets = { directory = "dist", binding = "ASSETS" }\n${namedEnvironment ? '[env.production]\nname = "config-production"\n' + queueSection.replaceAll("[[queues.", "[[env.production.queues.") : queueSection}`;
  await writeFile(configPath, source);
  const state = new Map(Object.entries(queues));
  const calls = [];
  const uploads = [];
  const temporaryConfigs = new Set();
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "queues") {
      const name = args[1] === "consumer" ? args[3] : args[2];
      if (args[1] === "create") {
        assert.ok(!state.has(name), "must reuse an existing Queue");
        state.set(name, []);
        return { exitCode: 0, stdout: "Created", stderr: "" };
      }
      if (!state.has(name)) {
        return { ...missingQueue, stderr: `Queue "${name}" does not exist.` };
      }
      return {
        exitCode: 0,
        stdout:
          args[1] === "consumer"
            ? JSON.stringify(state.get(name))
            : "Queue exists",
        stderr: "",
      };
    }
    const selectedPath = args[args.indexOf("--config") + 1];
    if (selectedPath !== configPath) temporaryConfigs.add(selectedPath);
    if (args[0] === "secret") {
      return failSecrets
        ? { exitCode: 1, stdout: "", stderr: "Secret lookup failed" }
        : {
            exitCode: 0,
            stdout: JSON.stringify([
              { name: "VAPID_PUBLIC_KEY" },
              { name: "VAPID_PRIVATE_KEY" },
              { name: "TEAM_DOMAIN" },
              { name: "POLICY_AUD" },
            ]),
            stderr: "",
          };
    }
    assert.equal(args[0], "deploy");
    assert.ok(!args.includes("--secrets-file"), "must preserve existing keys");
    const uploaded = await readDeploymentConfig(args.slice(1));
    uploads.push(uploaded);
    const name = uploaded.queues.producers.find(
      ({ binding }) => binding === "SYNC_QUEUE",
    ).queue;
    const consumers = state.get(name);
    assert.ok(
      consumers.every(
        (consumer) =>
          consumer.type === "worker" &&
          [consumer.script, consumer.service, consumer.script_name].includes(
            "gui-worker",
          ),
      ),
      "must not deploy a second consumer to an occupied Queue",
    );
    state.set(name, [{ type: "worker", script: "gui-worker" }]);
    return { exitCode: 0 };
  };
  const args = [
    "--config",
    configPath,
    ...(namedEnvironment ? ["--env=production"] : []),
  ];
  const options = {
    run,
    environment: { WRANGLER_CI_OVERRIDE_NAME: "gui-worker" },
  };
  return {
    args,
    options,
    state,
    calls,
    uploads,
    source,
    configPath,
    temporaryConfigs,
  };
}

test("reuses an unclaimed Queue and the current Worker's existing Queue", async (t) => {
  const ownConsumers = [{ type: "worker", script_name: "gui-worker" }];
  for (const queues of [
    { [queueName]: [] },
    { [queueName]: ownConsumers },
    { [queueName]: ownConsumers, "gui-worker-sync": ownConsumers },
  ]) {
    const fixture = await queueDeploymentFixture(t, queues);
    assert.equal(await deploy(fixture.args, fixture.options), 0);
    assert.equal(fixture.uploads[0].queues.producers[0].queue, queueName);
    assert.equal(fixture.state.size, Object.keys(queues).length);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.source);
  }
});

test("automatically uses a dedicated Queue when another Worker or HTTP consumer owns the configured Queue", async (t) => {
  for (const consumers of [
    [{ type: "worker", script: "old-worker" }],
    [{ type: "http_pull" }],
  ]) {
    const fixture = await queueDeploymentFixture(t, { [queueName]: consumers });
    assert.equal(await deploy(fixture.args, fixture.options), 0);
    assert.equal(
      fixture.uploads[0].queues.producers[0].queue,
      "gui-worker-sync",
    );
    assert.equal(
      fixture.uploads[0].queues.consumers[0].queue,
      "gui-worker-sync",
    );
    assert.deepEqual(fixture.state.get(queueName), consumers);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.source);
    assert.equal(fixture.temporaryConfigs.size, 1);
    for (const path of fixture.temporaryConfigs)
      await assert.rejects(access(path), { code: "ENOENT" });
  }
});

test("keeps a previously assigned dedicated Queue even after the original Queue becomes free", async (t) => {
  const fixture = await queueDeploymentFixture(t, {
    [queueName]: [],
    "gui-worker-sync": [{ type: "worker", service: "gui-worker" }],
  });
  assert.equal(await deploy(fixture.args, fixture.options), 0);
  assert.equal(fixture.uploads[0].queues.producers[0].queue, "gui-worker-sync");
  assert.equal(fixture.state.size, 2);
});

test("avoids an occupied dedicated Queue name and reuses it on the next deployment", async (t) => {
  const oldConsumers = [{ type: "worker", script: "old-worker" }];
  const fixture = await queueDeploymentFixture(t, {
    [queueName]: oldConsumers,
    "gui-worker-sync": oldConsumers,
  });
  assert.equal(await deploy(fixture.args, fixture.options), 0);
  assert.deepEqual(fixture.state.get(queueName), oldConsumers);
  fixture.state.set(queueName, []);
  assert.equal(await deploy(fixture.args, fixture.options), 0);
  assert.deepEqual(
    fixture.uploads.map((config) => config.queues.producers[0].queue),
    ["gui-worker-sync-2", "gui-worker-sync-2"],
  );
  assert.equal(fixture.state.size, 3);
  assert.deepEqual(fixture.state.get(queueName), []);
  assert.deepEqual(fixture.state.get("gui-worker-sync"), oldConsumers);
});

test("preserves relative paths and the selected named environment in the temporary deployment config", async (t) => {
  const fixture = await queueDeploymentFixture(
    t,
    {
      [queueName]: [{ type: "worker", script: "old-worker" }],
    },
    { namedEnvironment: true },
  );
  const original = await readDeploymentConfig(fixture.args);
  assert.equal(await deploy(fixture.args, fixture.options), 0);
  const uploaded = fixture.uploads[0];
  assert.equal(uploaded.main, original.main);
  assert.deepEqual(uploaded.assets, original.assets);
  assert.equal(uploaded.name, original.name);
  assert.equal(uploaded.queues.consumers[0].max_concurrency, 1);
  assert.equal(uploaded.queues.consumers[0].queue, "gui-worker-sync");
});

test("removes temporary Queue config when deployment preparation fails", async (t) => {
  const fixture = await queueDeploymentFixture(
    t,
    {
      [queueName]: [{ type: "worker", script: "old-worker" }],
    },
    { failSecrets: true },
  );
  await assert.rejects(
    deploy(fixture.args, fixture.options),
    /Secret lookup failed/,
  );
  assert.equal(fixture.uploads.length, 0);
  assert.equal(fixture.temporaryConfigs.size, 1);
  for (const path of fixture.temporaryConfigs)
    await assert.rejects(access(path), { code: "ENOENT" });
});
