export interface AgreementUseIdentity {
  genesisHash: string;
  digest: string;
}

export interface AgreementUseRecord extends AgreementUseIdentity {
  version: 1;
  deploymentTxId?: string;
  appId?: string;
}

export type AgreementUse = { deploymentTxId: string } | { appId: string };

export interface AgreementUseStore {
  withLock<T>(action: () => Promise<T>): Promise<T>;
  read(key: string): Promise<unknown>;
  write(key: string, record: AgreementUseRecord): Promise<void>;
  savedAppIds(identity: AgreementUseIdentity): Promise<string[]>;
}

export function agreementUseKey(identity: AgreementUseIdentity): string {
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(identity.genesisHash) ||
    !/^[0-9a-f]{64}$/.test(identity.digest)
  ) {
    throw new Error('Invalid agreement use identity.');
  }
  return 'leakswapAgreementUse:' + JSON.stringify([identity.genesisHash, identity.digest]);
}

function validateUse(value: unknown): asserts value is AgreementUseRecord {
  const record = value as AgreementUseRecord | null;
  if (
    !record ||
    record.version !== 1 ||
    Object.keys(record).some(
      (key) => !['version', 'genesisHash', 'digest', 'deploymentTxId', 'appId'].includes(key),
    ) ||
    (record.deploymentTxId === undefined && record.appId === undefined) ||
    (record.deploymentTxId !== undefined &&
      (typeof record.deploymentTxId !== 'string' ||
        !/^[A-Z2-7]{52}$/.test(record.deploymentTxId))) ||
    (record.appId !== undefined &&
      (typeof record.appId !== 'string' ||
        !/^[1-9][0-9]*$/.test(record.appId) ||
        BigInt(record.appId) > 0xffffffffffffffffn))
  )
    throw new Error('Invalid agreement use record.');
  agreementUseKey(record);
}

export function nextAgreementUse(
  identity: AgreementUseIdentity,
  previous: unknown,
  use: AgreementUse,
  savedAppIds: string[],
): AgreementUseRecord {
  const key = agreementUseKey(identity);
  let record: AgreementUseRecord = { version: 1, ...identity };
  if (previous !== null) {
    validateUse(previous);
    if (agreementUseKey(previous) !== key)
      throw new Error('Agreement use index does not match its identity.');
    record = { ...previous };
  }
  for (const appId of savedAppIds) {
    validateUse({ version: 1, ...identity, appId });
    if (record.appId !== undefined && record.appId !== appId)
      throw new Error('Agreement is already bound to another application.');
    record.appId = appId;
  }
  validateUse({ version: 1, ...identity, ...use });
  if ('deploymentTxId' in use) {
    if (
      (record.deploymentTxId !== undefined && record.deploymentTxId !== use.deploymentTxId) ||
      (record.appId !== undefined && record.deploymentTxId === undefined)
    ) {
      throw new Error(
        'Agreement is already reserved; a different deployment is permanently forbidden.',
      );
    }
    record.deploymentTxId = use.deploymentTxId;
  } else {
    if (record.appId !== undefined && record.appId !== use.appId)
      throw new Error('Agreement is already bound to another application.');
    record.appId = use.appId;
  }
  return record;
}

export async function reserveAgreementUse(
  store: AgreementUseStore,
  identity: AgreementUseIdentity,
  use: AgreementUse,
): Promise<void> {
  const key = agreementUseKey(identity);
  await store.withLock(async () => {
    const previous = await store.read(key);
    const record = nextAgreementUse(identity, previous, use, await store.savedAppIds(identity));
    await store.write(key, record);
  });
}
