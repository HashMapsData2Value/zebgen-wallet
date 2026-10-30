import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { MONERO_ENGLISH_PREFIX_LENGTH, MONERO_ENGLISH_WORDLIST } from './moneroWordlist.ts';

// Monero's 25-word seed is an Electrum-style mnemonic. Unlike BIP39 (which runs
// the phrase through PBKDF2 to derive a seed), this is a *direct, reversible
// base-1626 encoding* of the 32-byte private spend scalar: every 3 words encode
// 4 little-endian bytes, and the 25th word is a CRC32-derived checksum. Decoding
// returns the exact same bytes as the private spend key — no hashing involved.

const WORD_COUNT = MONERO_ENGLISH_WORDLIST.length; // 1626
const PREFIX_LEN = MONERO_ENGLISH_PREFIX_LENGTH; // 3

function wordPrefix(word: string): string {
  return word.length > PREFIX_LEN ? word.slice(0, PREFIX_LEN) : word;
}

// Prefix -> index. Monero wordlists are designed so the first `PREFIX_LEN`
// characters uniquely identify each word, which makes seeds tolerant of typos in
// the word tails.
const PREFIX_TO_INDEX: Map<string, number> = (() => {
  const map = new Map<string, number>();
  MONERO_ENGLISH_WORDLIST.forEach((word, index) => {
    map.set(wordPrefix(word), index);
  });
  return map;
})();

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) {
    return crcTable;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

// Standard IEEE CRC32 (matches boost::crc_32_type used by Monero).
function crc32(input: string): number {
  const table = getCrcTable();
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// The checksum word is one of the seed words, chosen by CRC32 over the
// concatenated word prefixes.
function checksumIndex(words: string[]): number {
  let trimmed = '';
  for (const word of words) {
    trimmed += wordPrefix(word);
  }
  return crc32(trimmed) % words.length;
}

function wordIndex(word: string): number {
  const index = PREFIX_TO_INDEX.get(wordPrefix(word));
  if (index === undefined) {
    throw new Error(`Unknown Monero mnemonic word: "${word}".`);
  }
  return index;
}

/**
 * Encode a private key (hex, length a multiple of 4 bytes — 32 for a spend key)
 * as a Monero mnemonic with a trailing checksum word (25 words for 32 bytes).
 */
export function privateKeyToMoneroMnemonic(privateKeyHex: string): string {
  const bytes = hexToBytes(privateKeyHex);
  if (bytes.length === 0 || bytes.length % 4 !== 0) {
    throw new Error('Private key length must be a non-zero multiple of 4 bytes.');
  }

  const words: string[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    // Little-endian uint32 (arithmetic avoids 32-bit sign issues).
    const value = bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536 + bytes[i + 3] * 16777216;
    const w1 = value % WORD_COUNT;
    const w2 = (Math.floor(value / WORD_COUNT) + w1) % WORD_COUNT;
    const w3 = (Math.floor(value / WORD_COUNT / WORD_COUNT) + w2) % WORD_COUNT;
    words.push(
      MONERO_ENGLISH_WORDLIST[w1],
      MONERO_ENGLISH_WORDLIST[w2],
      MONERO_ENGLISH_WORDLIST[w3],
    );
  }

  words.push(words[checksumIndex(words)]);
  return words.join(' ');
}

/**
 * Decode a Monero mnemonic (24 words, or 25 with a checksum word) back to the
 * exact private key bytes it encodes, as hex.
 */
export function moneroMnemonicToPrivateKey(mnemonic: string): string {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);

  let seedWords: string[];
  if (words.length === 25) {
    const provided = words[24];
    const expected = words[checksumIndex(words.slice(0, 24))];
    if (wordPrefix(provided) !== wordPrefix(expected)) {
      throw new Error('Invalid Monero mnemonic: checksum word does not match.');
    }
    seedWords = words.slice(0, 24);
  } else if (words.length === 24) {
    seedWords = words;
  } else {
    throw new Error('Monero mnemonic must be 24 or 25 words.');
  }

  const out = new Uint8Array((seedWords.length / 3) * 4);
  let offset = 0;
  for (let i = 0; i < seedWords.length; i += 3) {
    const w1 = wordIndex(seedWords[i]);
    const w2 = wordIndex(seedWords[i + 1]);
    const w3 = wordIndex(seedWords[i + 2]);
    const value =
      w1 +
      WORD_COUNT * ((WORD_COUNT - w1 + w2) % WORD_COUNT) +
      WORD_COUNT * WORD_COUNT * ((WORD_COUNT - w2 + w3) % WORD_COUNT);
    out[offset] = value & 0xff;
    out[offset + 1] = (value >>> 8) & 0xff;
    out[offset + 2] = (value >>> 16) & 0xff;
    out[offset + 3] = (value >>> 24) & 0xff;
    offset += 4;
  }
  return bytesToHex(out);
}
