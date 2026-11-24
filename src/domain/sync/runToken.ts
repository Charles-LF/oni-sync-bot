/**
 * 协作式取消令牌（领域层）。
 *
 * 只在**分片边界**（处理下一个页面 / 下一批图片之前）检查：
 * 进行中的那次 mwn 请求一定会跑完，前端点「停止」不会留下半截请求或卡死。
 *
 * 放在 domain 是为了让应用层用例可以接收 `RunToken`，而不依赖基础设施里的任务管理器。
 */

/** 主动停止时抛出的错误名，循环内部据此区分「中止」与「真异常」 */
export const ABORT_ERROR_NAME = "SyncAbortedError";

export class SyncAbortedError extends Error {
  constructor(message = "同步任务已停止") {
    super(message);
    this.name = ABORT_ERROR_NAME;
  }
}

export class RunToken {
  private stopped = false;
  private pausedFlag = false;
  private waiters: Array<() => void> = [];

  get paused(): boolean {
    return this.pausedFlag;
  }

  get aborted(): boolean {
    return this.stopped;
  }

  pause(): void {
    if (!this.stopped) this.pausedFlag = true;
  }

  resume(): void {
    this.pausedFlag = false;
    this.flush();
  }

  abort(): void {
    this.stopped = true;
    this.pausedFlag = false;
    this.flush();
  }

  /** 每个分片开始前调用：已停止则抛错，已暂停则原地等待 */
  async checkpoint(): Promise<void> {
    if (this.stopped) throw new SyncAbortedError();
    while (this.pausedFlag && !this.stopped) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.stopped) throw new SyncAbortedError();
  }

  private flush(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
