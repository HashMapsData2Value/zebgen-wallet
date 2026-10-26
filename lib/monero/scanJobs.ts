import { balanceCheckpointKey } from '../wallet/moneroBalanceCache';
import type {
  ScanMoneroBalanceRequest,
  ScanMoneroBalanceResult,
  MoneroFundingControl,
} from './moneroDaemon';

export function scanJobKey(request: ScanMoneroBalanceRequest): string {
  return balanceCheckpointKey(
    request.config.network,
    request.config.daemon.uri,
    request.primaryAddress,
    request.restoreHeight,
  );
}

type Progress = { scannedHeight: number; targetHeight: number };
type Job = {
  address: string;
  controller: AbortController;
  progress?: Progress;
  result?: ScanMoneroBalanceResult;
};

export class ScanJobs {
  private jobs = new Map<string, Job>();

  constructor(
    private scan: (
      request: ScanMoneroBalanceRequest,
      control: MoneroFundingControl,
    ) => Promise<ScanMoneroBalanceResult>,
    private notify: (
      key: string,
      event:
        | { type: 'progress'; progress: Progress }
        | { type: 'result'; result: ScanMoneroBalanceResult },
    ) => void,
  ) {}

  start(request: ScanMoneroBalanceRequest): void {
    const key = scanJobKey(request);
    const existing = this.jobs.get(key);
    if (existing && !existing.result) {
      if (existing.progress) this.notify(key, { type: 'progress', progress: existing.progress });
      return;
    }
    const job: Job = { address: request.primaryAddress, controller: new AbortController() };
    this.jobs.set(key, job);
    void this.scan(request, {
      signal: job.controller.signal,
      onProgress: (progress) => {
        job.progress = progress;
        this.notify(key, { type: 'progress', progress });
      },
    })
      .catch((error) => {
        console.error('Persistent Monero scan failed', error);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      })
      .then((result) => {
        job.result = result;
        this.notify(key, { type: 'result', result });
      });
  }

  stop(key: string): void {
    this.jobs.get(key)?.controller.abort();
  }
  get states() {
    return [...this.jobs.entries()].map(([key, job]) => ({
      key,
      address: job.address,
      progress: job.progress,
      result: job.result,
    }));
  }
  isActive(key: string): boolean {
    const job = this.jobs.get(key);
    return Boolean(job && !job.result);
  }
  get active(): boolean {
    return [...this.jobs.values()].some((job) => !job.result);
  }
}
