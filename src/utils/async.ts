import { sleep } from "koishi";

export { sleep };

/**
 * 统一的带重试执行器。
 *
 * 语义约定（替代原先散落的三套实现）：
 * - `attempts` 是**总尝试次数（含首次）**，不是"额外重试次数"；
 * - 全部失败后抛出**最后一次的错误本身**，不做包装，保留原始错误类型与 message；
 * - 只有"尝试次数未用尽"时才调用 `onRetry` 并等待。
 */
export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3，必须 >= 1 */
  attempts?: number;
  /** 每次重试前的等待毫秒数，默认 1000；<= 0 表示立即重试 */
  delayMs?: number;
  /** 每次失败后、下次尝试前的回调，用于记录日志 */
  onRetry?: (error: unknown, attempt: number, attempts: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { attempts = 3, delayMs = 1000, onRetry } = options;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts 必须是 >= 1 的整数，收到 ${attempts}`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      onRetry?.(error, attempt, attempts);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw lastError;
}
