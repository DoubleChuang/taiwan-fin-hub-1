const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(value: unknown, secret: string) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value)),
  );

  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptJson<TValue>(encrypted: string, secret: string) {
  const parsed = JSON.parse(encrypted) as {
    v: number;
    alg: "AES-GCM";
    iv: string;
    ciphertext: string;
  };

  if (parsed.v !== 1 || parsed.alg !== "AES-GCM") {
    throw new Error("Unsupported encrypted config format.");
  }

  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parsed.iv) },
    key,
    base64ToBytes(parsed.ciphertext),
  );

  return JSON.parse(decoder.decode(plaintext)) as TValue;
}

export async function encryptPayload(
  value: unknown,
  secret?: string | null,
): Promise<string> {
  if (value === null || value === undefined) {
    return "";
  }
  if (secret) {
    return encryptJson(value, secret);
  }
  return JSON.stringify(value) ?? "";
}

export async function decryptPayload<T = unknown>(
  payload: string | null | undefined,
  secret?: string | null,
): Promise<T | null> {
  if (!payload || typeof payload !== "string") {
    return null;
  }

  try {
    if (payload.startsWith('{"v":1,"alg":"AES-GCM"')) {
      if (!secret) {
        return null;
      }
      return await decryptJson<T>(payload, secret);
    }
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

export type EncryptableSyncRecord = {
  payload: Record<string, unknown>;
};

export async function encryptSyncRecordsRawPayload<
  TRecord extends EncryptableSyncRecord,
>(records: TRecord[], secret: string): Promise<TRecord[]> {
  if (!secret || records.length === 0) {
    return records;
  }

  const result: TRecord[] = [];
  for (const record of records) {
    const rawPayload = record.payload?.raw_payload;
    if (
      typeof rawPayload === "string" &&
      rawPayload.length > 0 &&
      !rawPayload.startsWith('{"v":1,"alg":"AES-GCM"')
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawPayload);
      } catch {
        parsed = rawPayload;
      }
      const encrypted = await encryptJson(parsed, secret);
      result.push({
        ...record,
        payload: {
          ...record.payload,
          raw_payload: encrypted,
        },
      });
    } else {
      result.push(record);
    }
  }
  return result;
}
