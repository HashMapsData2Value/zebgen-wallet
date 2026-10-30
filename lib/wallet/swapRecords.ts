import { decryptSeed, encryptSeed } from './seedVault.ts';
import {
  validateCombinedContext,
  type CombinedAddressContext,
  type ContextStorage,
} from './combinedAddressContext.ts';

export interface SwapRecord {
  settlement?: { kind: 'claim' | 'refund' | 'punish'; txId: string; confirmedRound: string };
  agreementDigest?: string;
  version: 1;
  genesisHash: string;
  appId: string;
  appAddress: string;
  role: 'ali' | 'xin';
  algoAddress: string;
  aliAddress: string;
  xinAddress: string;
  t0: number;
  t1: number;
  deadlineUnit: 'round';
  createdRound: number;
  context: CombinedAddressContext;
}

export interface SignedTransactionRecord {
  version: 1;
  genesisHash: string;
  txId: string;
  sender: string;
  origin: string;
  firstValid: string;
  lastValid: string;
  unsignedTransaction: string;
  signedAt: string;
}

const SWAPS = 'leakswapRecord:';
const JOURNAL = 'signedAlgoTransaction:';
const HASH = /^[A-Za-z0-9+/]{43}=$/;
const ADDRESS = /^[A-Z2-7]{58}$/;

export interface SettlementEvidence {
  txId: string;
  confirmedRound: string;
  transaction: string;
}

function validateSettlementEvidence(evidence: SettlementEvidence): void {
  if (
    !evidence ||
    !/^[A-Z2-7]{52}$/.test(evidence.txId) ||
    !/^[1-9][0-9]*$/.test(evidence.confirmedRound) ||
    typeof evidence.transaction !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(evidence.transaction)
  ) {
    throw new Error('Invalid saved settlement evidence.');
  }
}

export async function loadSettlementEvidence(
  storage: ContextStorage,
  record: SwapRecord,
  secret: string,
): Promise<SettlementEvidence | null> {
  const evidence = (await readEncrypted(
    storage,
    `leakswapSettlementEvidence:${swapRecordKey(record)}`,
    secret,
  )) as SettlementEvidence | null;
  if (evidence) validateSettlementEvidence(evidence);
  return evidence;
}

export async function saveSettlementEvidence(
  storage: ContextStorage,
  record: SwapRecord,
  evidence: SettlementEvidence,
  secret: string,
): Promise<void> {
  validateSettlementEvidence(evidence);
  const previous = await loadSettlementEvidence(storage, record, secret);
  if (previous && JSON.stringify(previous) !== JSON.stringify(evidence))
    throw new Error('Saved settlement evidence cannot be replaced.');
  await writeEncrypted(
    storage,
    `leakswapSettlementEvidence:${swapRecordKey(record)}`,
    evidence,
    secret,
  );
}

export function validateSwapRecord(value: unknown): asserts value is SwapRecord {
  const record = value as SwapRecord | null;
  if (record && record.deadlineUnit !== 'round')
    throw new Error(
      'Legacy timestamp swap records are not supported. Create a new round-based swap; stored data has not been changed.',
    );
  if (
    !record ||
    record.version !== 1 ||
    !HASH.test(record.genesisHash) ||
    !/^[1-9][0-9]*$/.test(record.appId) ||
    BigInt(record.appId) > 0xffffffffffffffffn ||
    ![record.appAddress, record.algoAddress, record.aliAddress, record.xinAddress].every(
      (address) => typeof address === 'string' && ADDRESS.test(address),
    ) ||
    !['ali', 'xin'].includes(record.role) ||
    !Number.isSafeInteger(record.createdRound) ||
    record.createdRound <= 0 ||
    record.createdRound >= record.t0 ||
    record.algoAddress !== (record.role === 'ali' ? record.aliAddress : record.xinAddress) ||
    !Number.isSafeInteger(record.t0) ||
    record.t0 < 0 ||
    !Number.isSafeInteger(record.t1) ||
    record.t1 <= record.t0 ||
    !record.context
  )
    throw new Error('Invalid saved swap record.');
  validateCombinedContext(record.context, record.context);
  if (
    record.settlement &&
    (!['claim', 'refund', 'punish'].includes(record.settlement.kind) ||
      !/^[A-Z2-7]{52}$/.test(record.settlement.txId) ||
      !/^[1-9][0-9]*$/.test(record.settlement.confirmedRound))
  ) {
    throw new Error('Invalid saved settlement.');
  }
  if (record.agreementDigest !== undefined && !/^[0-9a-f]{64}$/.test(record.agreementDigest))
    throw new Error('Invalid saved agreement digest.');
}

export function swapRecordKey(record: SwapRecord): string {
  validateSwapRecord(record);
  return (
    SWAPS +
    JSON.stringify([record.genesisHash, record.algoAddress, record.context.walletId, record.appId])
  );
}

async function readEncrypted(
  storage: ContextStorage,
  key: string,
  secret: string,
): Promise<unknown> {
  const envelope = (await storage.get(key))[key];
  if (envelope === undefined) return null;
  const encrypted = envelope as {
    version: number;
    ciphertext: number[];
    salt: number[];
    iv: number[];
  };
  const bytes = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (
    !encrypted ||
    encrypted.version !== 1 ||
    !bytes(encrypted.ciphertext) ||
    !bytes(encrypted.salt) ||
    encrypted.salt.length !== 16 ||
    !bytes(encrypted.iv) ||
    encrypted.iv.length !== 12
  )
    throw new Error('Invalid encrypted swap record.');
  const plaintext = await decryptSeed(
    new Uint8Array(encrypted.ciphertext).buffer,
    secret,
    new Uint8Array(encrypted.salt),
    new Uint8Array(encrypted.iv),
  );
  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

async function writeEncrypted(
  storage: ContextStorage,
  key: string,
  value: unknown,
  secret: string,
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    const encrypted = await encryptSeed(plaintext, secret);
    await storage.set({
      [key]: {
        version: 1,
        ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
        salt: Array.from(encrypted.salt),
        iv: Array.from(encrypted.iv),
      },
    });
  } finally {
    plaintext.fill(0);
  }
}

export async function saveSwapRecord(
  storage: ContextStorage,
  record: SwapRecord,
  secret: string,
): Promise<void> {
  const key = swapRecordKey(record);
  const previous = await readEncrypted(storage, key, secret);
  if (previous !== null) {
    validateSwapRecord(previous);
    const previousIdentity = {
      ...previous,
      settlement: undefined,
      context: { ...previous.context, restoreHeight: 0 },
    };
    const identity = {
      ...record,
      settlement: undefined,
      context: { ...record.context, restoreHeight: 0 },
    };
    if (JSON.stringify(previousIdentity) !== JSON.stringify(identity))
      throw new Error('Saved swap identity cannot be replaced.');
    if (
      previous.settlement &&
      record.settlement &&
      JSON.stringify(previous.settlement) !== JSON.stringify(record.settlement)
    )
      throw new Error('Confirmed settlement cannot be replaced.');
  }
  await writeEncrypted(
    storage,
    key,
    {
      ...record,
      ...((previous as SwapRecord | null)?.settlement
        ? { settlement: (previous as SwapRecord).settlement }
        : {}),
      context: {
        ...record.context,
        restoreHeight: Math.min(
          (previous as SwapRecord | null)?.context.restoreHeight ?? record.context.restoreHeight,
          record.context.restoreHeight,
        ),
      },
    },
    secret,
  );
}

export async function listSwapRecords(
  storage: ContextStorage,
  secret: string,
): Promise<SwapRecord[]> {
  const records: SwapRecord[] = [];
  for (const key of Object.keys(await storage.get(null)).filter((key) => key.startsWith(SWAPS))) {
    const record = await readEncrypted(storage, key, secret);
    validateSwapRecord(record);
    if (swapRecordKey(record) !== key)
      throw new Error('Saved swap index does not match its identity.');
    records.push(record);
  }
  return records;
}

function transactionKey(record: SignedTransactionRecord): string {
  if (
    record.version !== 1 ||
    !HASH.test(record.genesisHash) ||
    !/^[A-Z2-7]{52}$/.test(record.txId) ||
    !ADDRESS.test(record.sender) ||
    !/^\d+$/.test(record.firstValid) ||
    !/^\d+$/.test(record.lastValid) ||
    BigInt(record.firstValid) > BigInt(record.lastValid) ||
    typeof record.origin !== 'string' ||
    typeof record.unsignedTransaction !== 'string' ||
    record.unsignedTransaction.length === 0 ||
    !Number.isFinite(Date.parse(record.signedAt))
  )
    throw new Error('Invalid signed transaction record.');
  return JOURNAL + JSON.stringify([record.genesisHash, record.sender, record.txId]);
}

export async function saveSignedTransactions(
  storage: ContextStorage,
  records: SignedTransactionRecord[],
  secret: string,
): Promise<void> {
  for (const record of records) transactionKey(record);
  for (const record of records)
    await writeEncrypted(storage, transactionKey(record), record, secret);
}

export async function listSignedTransactions(
  storage: ContextStorage,
  secret: string,
): Promise<SignedTransactionRecord[]> {
  const records: SignedTransactionRecord[] = [];
  for (const key of Object.keys(await storage.get(null)).filter((key) => key.startsWith(JOURNAL))) {
    const record = (await readEncrypted(storage, key, secret)) as SignedTransactionRecord;
    if (!record || transactionKey(record) !== key)
      throw new Error('Signed transaction index does not match its identity.');
    records.push(record);
  }
  return records;
}
