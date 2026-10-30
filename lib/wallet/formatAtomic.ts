export function formatAtomic(value: string | bigint, decimals: number): string {
  const amount = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / scale}${fraction ? `.${fraction}` : ''}`;
}
