import { compactDecrypt } from 'jose';
import { promisify } from 'node:util';
import { inflateRaw as zlibInflateRaw } from 'node:zlib';

const inflateRawAsync = promisify(zlibInflateRaw);

/**
 * Decrypt a JWE compact serialization string using the SHL key.
 *
 * SHL uses: alg: "dir", enc: "A256GCM", optional zip: "DEF" (raw DEFLATE).
 * jose v4 supports DEFLATE via the inflateRaw option.
 *
 * @param {string} jweString - JWE compact serialization
 * @param {Uint8Array} keyBytes - 32-byte AES-256 key
 * @param {number} maxSize - Max decompressed payload size (DoS protection)
 * @returns {{ content: Uint8Array, contentType: string|undefined }}
 */
export async function decryptJwe(jweString, keyBytes, maxSize = 5_000_000) {
  const { plaintext, protectedHeader } = await compactDecrypt(jweString, keyBytes, {
    inflateRaw: async (input) => {
      const result = await inflateRawAsync(input, { maxOutputLength: maxSize });
      return new Uint8Array(result);
    },
    contentEncryptionAlgorithms: ['A256GCM'],
    keyManagementAlgorithms: ['dir'],
  });

  return {
    content: plaintext,
    contentType: protectedHeader.cty,
  };
}

/**
 * Decrypt and parse a JWE string, returning the content as a UTF-8 string.
 */
export async function decryptToString(jweString, keyBytes, maxSize = 5_000_000) {
  const { content, contentType } = await decryptJwe(jweString, keyBytes, maxSize);
  return {
    text: new TextDecoder().decode(content),
    contentType,
  };
}
