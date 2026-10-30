export interface SwapStatusSnapshot {
  role: 'ali' | 'xin';
  t0: number;
  t1: number;
  state: 'unknown' | 'unavailable' | 'awaiting' | 'ready';
  funding: 'unknown' | 'empty' | 'present';
  checkedAt: number;
  chainRound?: number;
  deadlineUnit: 'round';
  issue?: string;
}

export function swapStatus(swap: SwapStatusSnapshot, now: number) {
  if (swap.deadlineUnit !== 'round') throw new Error('Legacy timestamp swaps are not supported.');
  if (now - swap.checkedAt > 90 || swap.state === 'unknown')
    return {
      priority: 2,
      title: 'Status not verified',
      detail: swap.issue ?? 'Refresh the chain status before funding, claiming, or refunding.',
    };
  if (swap.state === 'unavailable')
    return {
      priority: 0,
      title: 'Contract no longer available',
      detail:
        'The application was not found on its saved network. Settlement history is needed to identify a claim or refund.',
    };
  const current = swap.chainRound;
  if (current === undefined || !Number.isSafeInteger(current) || current < 0)
    return {
      priority: 2,
      title: 'Chain round unavailable',
      detail: 'Refresh the chain status before deciding which actions are available.',
    };
  if (current >= swap.t1)
    return {
      priority: swap.role === 'ali' ? 3 : 2,
      title: swap.role === 'ali' ? 'Punish refund available' : 'Claim window closed',
      detail:
        swap.role === 'ali'
          ? 'Final expiry has passed. You can request the remaining ALGO without revealing your Monero spend key.'
          : 'A leaky claim is no longer allowed. Ali can request a punish refund. Do not send more XMR.',
    };
  if (swap.state === 'ready' || current > swap.t0)
    return {
      priority: swap.role === 'xin' ? 3 : 1,
      title: swap.role === 'xin' ? 'Leaky claim available' : 'Waiting for Xin to claim',
      detail:
        swap.role === 'xin'
          ? 'Verify your XMR deposit before claiming the ALGO. A leaky claim reveals your Monero spend key.'
          : 'Xin can claim the ALGO. Leaky refund is no longer allowed. Monitor settlement before final expiry.',
    };
  if (swap.funding === 'empty')
    return {
      priority: 1,
      title: 'Waiting for ALGO funding',
      detail:
        swap.role === 'ali'
          ? 'The ALGO escrow is empty. Review the agreed amount before funding.'
          : 'Ali has not funded the ALGO escrow. Do not send XMR yet.',
    };
  if (swap.funding === 'unknown')
    return {
      priority: 2,
      title: 'ALGO funding not verified',
      detail:
        'The contract is not ready, but its escrow balance could not be checked. Do not send new funds.',
    };
  return {
    priority: swap.t0 - current <= 1200 ? 3 : 1,
    title:
      swap.role === 'ali'
        ? 'Waiting for XMR verification / Set Ready'
        : 'Waiting for deposit verification / Set Ready',
    detail:
      swap.role === 'ali'
        ? 'ALGO is present. Check the agreed amounts and scan the XMR deposit before Set Ready. Leaky refund is allowed while not ready, through t0.'
        : 'ALGO is present, but its balance alone does not verify the agreed funding. Check the terms and XMR deposit; Ali must verify it before Set Ready. Leaky claim also opens after t0.',
  };
}
