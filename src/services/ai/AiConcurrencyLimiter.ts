/**
 * AiConcurrencyLimiter.ts
 *
 * Semaphore giới hạn số LLM request chạy đồng thời trên Boss.
 * Với 5-10 employee cùng gọi về một GPU Ollama, request dồn ập làm
 * inference chậm và timeout hàng loạt. Limiter xếp hàng phần còn lại.
 *
 * Main process only. Pure logic — unit-testable.
 */

import Logger from '../../utils/Logger';

export interface LimiterStats {
  running: number;
  queued: number;
  limit: number;
}

class Semaphore {
  constructor(private readonly limit: number) {}

  private running = 0;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  stats(): LimiterStats {
    return { running: this.running, queued: this.queue.length, limit: this.limit };
  }
}

/** Default: 2 concurrent — hợp lý cho 1 GPU chạy model 7-14B. */
const DEFAULT_LOCAL_LIMIT = 2;
const CLOUD_LIMIT = 8;

const localSemaphore = new Semaphore(DEFAULT_LOCAL_LIMIT);
const cloudSemaphore = new Semaphore(CLOUD_LIMIT);

function isLocalPlatform(platform: string): boolean {
  return platform === 'ollama' || platform === 'lmstudio' || platform === '9router';
}

/**
 * Chạy fn dưới semaphore tương ứng theo platform.
 * Trả về result của fn; lỗi được ném lại sau khi release.
 */
export async function withAiLimit<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const sem = isLocalPlatform(platform) ? localSemaphore : cloudSemaphore;
  const stats = sem.stats();
  if (stats.queued > 0) {
    Logger.log(`[AiLimiter] ${platform}: ${stats.running}/${stats.limit} chạy, ${stats.queued} đang chờ`);
  }
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

export function getLimiterStats(): { local: LimiterStats; cloud: LimiterStats } {
  return { local: localSemaphore.stats(), cloud: cloudSemaphore.stats() };
}
