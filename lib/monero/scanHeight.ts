export function sanitizeBlockHeight(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

export function walletRestoreHeight(
  wallet:
    | {
        restoreHeight?: number;
        restoreNetwork?: string;
        scanRestoreHeights?: Record<string, number>;
      }
    | undefined,
  network: string,
): number {
  const height =
    wallet?.scanRestoreHeights?.[network] ??
    (wallet?.restoreNetwork === network ? wallet.restoreHeight : undefined);
  return Number.isSafeInteger(height) && height! >= 0 && height! <= 0xffffffff ? height! : 0;
}
