import assert from "node:assert/strict";
import { parseRakutenConfig, parseRakutenData } from "../../src/rakuten";

assert.deepEqual(
  parseRakutenConfig({
    userId: "A123456789",
    account: "rakuten-user",
    password: "password",
  }),
  {
    userId: "A123456789",
    account: "rakuten-user",
    password: "password",
  },
);

assert.throws(() => parseRakutenConfig({ captcha: "123" }));
assert.throws(() => parseRakutenConfig({ captcha: "toolong" }));

const depositPageText = `
臺幣存款
活存總額 0081200000001234
$52,345
`;

const result = parseRakutenData({ depositPageText });

assert.equal(result.bankAccounts.length, 1);
const savings = result.bankAccounts[0];
assert.equal(savings?.sourceId, "bank:rakuten:0081200000001234:TWD");
assert.equal(savings?.accountType, "savings");

assert.equal(result.bankBalanceSnapshots.length, 1);
assert.equal(result.bankBalanceSnapshots[0]?.accountId, savings?.sourceId);
assert.equal(result.bankBalanceSnapshots[0]?.balance, 52_345);

// No deposit payload or text: nothing should be produced.
assert.equal(parseRakutenData({}).bankAccounts.length, 0);

console.log("Rakuten connector self-check passed.");
