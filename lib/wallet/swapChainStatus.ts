import algosdk from 'algosdk';
import type { SwapRecord } from './swapRecords';
import type { SwapStatusSnapshot } from './swapStatus';

export interface SavedSwapStatus extends SwapStatusSnapshot {
  origin?: string;
  appId: string;
  genesisHash: string;
  moneroNetwork: string;
  escrowAtomic?: string;
}

export async function readSwapChainStatus(
  record: SwapRecord,
  client: algosdk.Algodv2 | null,
  genesis: string,
  checkedAt: number,
  chainRound?: number,
): Promise<SavedSwapStatus> {
  const result: SavedSwapStatus = {
    ...(record.origin ? { origin: record.origin } : {}),
    appId: record.appId,
    genesisHash: record.genesisHash,
    moneroNetwork: record.context.network,
    role: record.role,
    t0: record.t0,
    t1: record.t1,
    state: 'unknown',
    funding: 'unknown',
    checkedAt,
    chainRound,
    deadlineUnit: record.deadlineUnit,
  };
  if (!client)
    return { ...result, issue: 'The Algorand node could not be reached. Refresh to try again.' };
  if (genesis !== record.genesisHash)
    return {
      ...result,
      issue:
        'This swap belongs to another Algorand network. Select its network in Algorand settings, then refresh.',
    };
  if (algosdk.getApplicationAddress(BigInt(record.appId)).toString() !== record.appAddress)
    return {
      ...result,
      issue: 'The saved escrow address does not match this application. Do not send funds.',
    };
  try {
    const app = await client.getApplicationByID(BigInt(record.appId)).do();
    const globals = app.params?.globalState;
    const value = (key: string) =>
      globals?.find((entry) => new TextDecoder().decode(entry.key) === key)?.value;
    const t0 = value('t0');
    const t1 = value('t1');
    const ready = value('aliReady');
    const ali = value('aliAlgoAddr');
    const xin = value('xinAlgoAddr');
    if (
      !t0 ||
      !t1 ||
      !ready ||
      !ali ||
      !xin ||
      t0.type !== 2 ||
      t1.type !== 2 ||
      ready.type !== 2 ||
      ali.type !== 1 ||
      xin.type !== 1 ||
      t0.uint !== BigInt(record.t0) ||
      t1.uint !== BigInt(record.t1) ||
      ready.uint > 1n ||
      algosdk.encodeAddress(ali.bytes) !== record.aliAddress ||
      algosdk.encodeAddress(xin.bytes) !== record.xinAddress
    ) {
      return { ...result, issue: 'Contract terms do not match the saved swap. Do not send funds.' };
    }
    result.state = ready.uint === 1n ? 'ready' : 'awaiting';
  } catch (failure) {
    if ((failure as { status?: number }).status === 404) return { ...result, state: 'unavailable' };
    console.error(`Could not read swap ${record.appId}.`, failure);
    return { ...result, issue: 'Could not read this contract. Refresh to check again.' };
  }
  try {
    const account = await client.accountInformation(record.appAddress).do();
    result.escrowAtomic = account.amount.toString();
    result.funding = account.amount === 0n ? 'empty' : 'present';
  } catch (failure) {
    if ((failure as { status?: number }).status === 404) {
      result.escrowAtomic = '0';
      result.funding = 'empty';
    } else console.error(`Could not read swap ${record.appId} escrow.`, failure);
  }
  return result;
}
