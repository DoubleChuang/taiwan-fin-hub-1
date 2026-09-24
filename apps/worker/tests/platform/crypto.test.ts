import { describe, expect, it } from "vitest";
import {
  decryptJson,
  decryptPayload,
  encryptJson,
  encryptPayload,
} from "../../src/platform/crypto";
import {
  encryptSyncRecordsRawPayload,
  type SyncWriteRecord,
} from "../../src/features/sync/persistence";

describe("crypto platform utilities", () => {
  const secretKey = "super-secret-test-key-1234567890";
  const wrongSecretKey = "different-wrong-secret-key-99999";

  describe("encryptPayload and decryptPayload round-trip", () => {
    it("encrypts and decrypts an object payload with secret", async () => {
      const original = {
        accountId: "acc-123",
        balance: 54321,
        active: true,
        tags: ["checking", "primary"],
        metadata: { branch: "Taipei", code: 42 },
      };

      const encrypted = await encryptPayload(original, secretKey);
      expect(typeof encrypted).toBe("string");
      expect(encrypted.startsWith('{"v":1,"alg":"AES-GCM"')).toBe(true);

      const decrypted = await decryptPayload<typeof original>(
        encrypted,
        secretKey,
      );
      expect(decrypted).toEqual(original);
    });

    it("encrypts and decrypts array, string, number, and boolean values with secret", async () => {
      const arrayVal = [1, "two", { three: 3 }];
      const encArray = await encryptPayload(arrayVal, secretKey);
      expect(await decryptPayload(encArray, secretKey)).toEqual(arrayVal);

      const stringVal = "financial-data-test";
      const encString = await encryptPayload(stringVal, secretKey);
      expect(await decryptPayload(encString, secretKey)).toEqual(stringVal);

      const numberVal = 98765.43;
      const encNumber = await encryptPayload(numberVal, secretKey);
      expect(await decryptPayload(encNumber, secretKey)).toEqual(numberVal);

      const boolVal = true;
      const encBool = await encryptPayload(boolVal, secretKey);
      expect(await decryptPayload(encBool, secretKey)).toEqual(boolVal);
    });

    it("returns null when decrypting with the wrong secret", async () => {
      const payload = { sensitive: "confidential banking details" };
      const encrypted = await encryptPayload(payload, secretKey);

      const decrypted = await decryptPayload(encrypted, wrongSecretKey);
      expect(decrypted).toBeNull();
    });

    it("falls back to JSON.stringify when secret is omitted, null, or undefined", async () => {
      const data = { hello: "world", count: 10 };

      const unencryptedUndefined = await encryptPayload(data, undefined);
      expect(unencryptedUndefined).toBe(JSON.stringify(data));

      const unencryptedNull = await encryptPayload(data, null);
      expect(unencryptedNull).toBe(JSON.stringify(data));

      const unencryptedNoSecret = await encryptPayload(data);
      expect(unencryptedNoSecret).toBe(JSON.stringify(data));
    });

    it("returns empty string when value is null or undefined", async () => {
      expect(await encryptPayload(null, secretKey)).toBe("");
      expect(await encryptPayload(undefined, secretKey)).toBe("");
      expect(await encryptPayload(null)).toBe("");
      expect(await encryptPayload(undefined)).toBe("");
    });
  });

  describe("decryptPayload backward compatibility", () => {
    it("parses unencrypted legacy JSON object string correctly without secret", async () => {
      const legacyJson = JSON.stringify({
        accountNumber: "12345678",
        balance: 1000,
        currency: "TWD",
      });

      const result = await decryptPayload(legacyJson);
      expect(result).toEqual({
        accountNumber: "12345678",
        balance: 1000,
        currency: "TWD",
      });
    });

    it("parses unencrypted legacy JSON string correctly even if secret is provided", async () => {
      const legacyJson = JSON.stringify({
        accountNumber: "87654321",
        note: "legacy unencrypted record",
      });

      const result = await decryptPayload(legacyJson, secretKey);
      expect(result).toEqual({
        accountNumber: "87654321",
        note: "legacy unencrypted record",
      });
    });

    it("parses unencrypted primitive JSON values", async () => {
      expect(await decryptPayload("12345")).toBe(12345);
      expect(await decryptPayload('"hello"')).toBe("hello");
      expect(await decryptPayload("[1, 2, 3]")).toEqual([1, 2, 3]);
      expect(await decryptPayload("true")).toBe(true);
    });
  });

  describe("decryptPayload error handling and edge cases", () => {
    it("returns null for null, undefined, or empty payload", async () => {
      expect(await decryptPayload(null, secretKey)).toBeNull();
      expect(await decryptPayload(undefined, secretKey)).toBeNull();
      expect(await decryptPayload("", secretKey)).toBeNull();
      expect(await decryptPayload(null)).toBeNull();
      expect(await decryptPayload(undefined)).toBeNull();
      expect(await decryptPayload("")).toBeNull();
    });

    it("returns null for non-string input", async () => {
      expect(await decryptPayload(12345 as unknown as string)).toBeNull();
      expect(await decryptPayload({} as unknown as string)).toBeNull();
    });

    it("returns null for malformed JSON strings", async () => {
      expect(await decryptPayload("{malformed-json")).toBeNull();
      expect(
        await decryptPayload("not valid json at all", secretKey),
      ).toBeNull();
    });

    it("returns null when encrypted payload is decrypted without a secret", async () => {
      const encrypted = await encryptJson({ secret: "data" }, secretKey);
      expect(await decryptPayload(encrypted)).toBeNull();
      expect(await decryptPayload(encrypted, null)).toBeNull();
      expect(await decryptPayload(encrypted, "")).toBeNull();
    });

    it("returns null when encrypted payload has corrupted structure or ciphertext", async () => {
      const encrypted = await encryptJson({ secret: "data" }, secretKey);
      const parsed = JSON.parse(encrypted);

      // Corrupt ciphertext
      const corruptedCiphertext = JSON.stringify({
        ...parsed,
        ciphertext: "not-valid-base64-or-bad-ciphertext!@#$",
      });
      expect(await decryptPayload(corruptedCiphertext, secretKey)).toBeNull();

      // Corrupt iv
      const corruptedIv = JSON.stringify({
        ...parsed,
        iv: "invalid-iv",
      });
      expect(await decryptPayload(corruptedIv, secretKey)).toBeNull();

      // Malformed json starting with prefix
      const brokenPrefix = '{"v":1,"alg":"AES-GCM",broken json';
      expect(await decryptPayload(brokenPrefix, secretKey)).toBeNull();
    });
  });

  describe("encryptSyncRecordsRawPayload", () => {
    it("encrypts raw_payload for records while keeping all other fields intact", async () => {
      const records: SyncWriteRecord[] = [
        {
          entityType: "bank_account",
          recordKey: "rec-bank-1",
          payload: {
            id: "rec-bank-1",
            connector_id: "test-connector",
            source_id: "src-1",
            account_name: "Test Account",
            amount: 50000,
            raw_payload: JSON.stringify({
              rawAccountNo: "987654",
              tier: "VIP",
            }),
            created_at: "2026-01-01T00:00:00Z",
          },
        },
        {
          entityType: "bank_transaction",
          recordKey: "rec-tx-1",
          payload: {
            id: "rec-tx-1",
            connector_id: "test-connector",
            source_id: "tx-1",
            amount: -1200,
            raw_payload: JSON.stringify({ txCode: "ATM", fee: 15 }),
            created_at: "2026-01-01T00:00:00Z",
          },
        },
      ];

      const processed = await encryptSyncRecordsRawPayload(records, secretKey);

      expect(processed).toHaveLength(2);

      // First record assertions
      const rec0 = processed[0];
      expect(rec0.entityType).toBe("bank_account");
      expect(rec0.recordKey).toBe("rec-bank-1");
      expect(rec0.payload.id).toBe("rec-bank-1");
      expect(rec0.payload.connector_id).toBe("test-connector");
      expect(rec0.payload.account_name).toBe("Test Account");
      expect(rec0.payload.amount).toBe(50000);
      expect(rec0.payload.created_at).toBe("2026-01-01T00:00:00Z");

      const rec0Raw = rec0.payload.raw_payload as string;
      expect(rec0Raw.startsWith('{"v":1,"alg":"AES-GCM"')).toBe(true);
      const rec0Decrypted = await decryptPayload(rec0Raw, secretKey);
      expect(rec0Decrypted).toEqual({ rawAccountNo: "987654", tier: "VIP" });

      // Second record assertions
      const rec1 = processed[1];
      expect(rec1.entityType).toBe("bank_transaction");
      expect(rec1.recordKey).toBe("rec-tx-1");
      expect(rec1.payload.id).toBe("rec-tx-1");
      expect(rec1.payload.amount).toBe(-1200);

      const rec1Raw = rec1.payload.raw_payload as string;
      expect(rec1Raw.startsWith('{"v":1,"alg":"AES-GCM"')).toBe(true);
      const rec1Decrypted = await decryptPayload(rec1Raw, secretKey);
      expect(rec1Decrypted).toEqual({ txCode: "ATM", fee: 15 });
    });

    it("does not re-encrypt already encrypted raw_payload", async () => {
      const alreadyEncrypted = await encryptJson(
        { already: "encrypted" },
        secretKey,
      );

      const records: SyncWriteRecord[] = [
        {
          entityType: "bank_account",
          recordKey: "rec-1",
          payload: {
            id: "rec-1",
            raw_payload: alreadyEncrypted,
          },
        },
      ];

      const processed = await encryptSyncRecordsRawPayload(records, secretKey);
      expect(processed[0].payload.raw_payload).toBe(alreadyEncrypted);
    });

    it("handles records with missing, null, or empty raw_payload", async () => {
      const records: SyncWriteRecord[] = [
        {
          entityType: "net_worth_history",
          recordKey: "nw-1",
          payload: {
            id: "nw-1",
            date: "2026-01-01",
          },
        },
        {
          entityType: "bank_account",
          recordKey: "ba-empty",
          payload: {
            id: "ba-empty",
            raw_payload: "",
          },
        },
        {
          entityType: "bank_account",
          recordKey: "ba-null",
          payload: {
            id: "ba-null",
            raw_payload: null,
          },
        },
      ];

      const processed = await encryptSyncRecordsRawPayload(records, secretKey);
      expect(processed[0].payload.raw_payload).toBeUndefined();
      expect(processed[1].payload.raw_payload).toBe("");
      expect(processed[2].payload.raw_payload).toBeNull();
    });

    it("returns records untouched if secret is empty", async () => {
      const records: SyncWriteRecord[] = [
        {
          entityType: "bank_account",
          recordKey: "rec-1",
          payload: {
            id: "rec-1",
            raw_payload: '{"some":"json"}',
          },
        },
      ];

      const processed = await encryptSyncRecordsRawPayload(records, "");
      expect(processed).toBe(records);
    });
  });
});
