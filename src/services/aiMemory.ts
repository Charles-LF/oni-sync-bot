/** 一轮短期记忆：问题、回答，以及当轮查过的页面（供追问时兜底复用） */
export interface MemoryTurn {
  question: string;
  answer: string;
  /** 这一轮实际检索到的页面标题；留空表示没查到（旧版本存的是 `chunks`，运行时忽略） */
  page?: string;
  at: number;
}

/**
 * `.ai` 的短期记忆（内存 Map，由调用方负责落库）。
 *
 * 为什么需要它：`ai 电解器耗电多少` 之后接一句「那它能干什么」，
 * 模型看不到上一问就无从知道「它」指谁。
 *
 * 边界约定：
 * - `maxTurns <= 0` 表示关闭记忆；
 * - 每轮超过 `ttlMs` 视为新话题（默认 10 分钟），避免很早之前的问答污染当前问题；
 * - 每个键（平台:频道:用户 / topic:平台:频道）只保留最近 `maxTurns` 轮；
 * - 本类**不直接读写数据库**：重启后的恢复由 `AiMemory.restore()` + 调用方的
 *   `loadMemory()` 完成（`oniaimemory` 表），这样纯函数部分可以单测。
 */
export class AiMemory {
  private readonly store = new Map<string, MemoryTurn[]>();

  constructor(
    private readonly maxTurns: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return this.maxTurns > 0;
  }

  /** 读取最近的记忆轮次（已剔除过期项，并按 `maxTurns` 截断） */
  get(key: string | undefined): MemoryTurn[] {
    if (!key || !this.enabled) return [];

    const stored = this.store.get(key);
    if (!stored?.length) return [];

    const fresh = this.prune(stored);
    if (fresh.length === 0) {
      this.store.delete(key);
      return [];
    }
    if (fresh.length !== stored.length) this.store.set(key, fresh);
    return fresh;
  }

  /**
   * 用外部来源（数据库）恢复某个键的记忆。
   *
   * 重启后内存为空，由调用方从库里读出来灌回内存；同样会做 TTL 与轮数裁剪。
   */
  restore(key: string, turns: MemoryTurn[]): MemoryTurn[] {
    if (!key || !this.enabled || turns.length === 0) return [];
    const fresh = this.prune(turns).slice(-this.maxTurns);
    if (fresh.length > 0) this.store.set(key, fresh);
    return fresh;
  }

  /** 追加一轮问答；超出上限时丢弃最旧的一轮 */
  add(
    key: string | undefined,
    turn: { question: string; answer: string; page?: string },
  ): void {
    if (!key || !this.enabled) return;

    const stored = this.store.get(key) ?? [];
    stored.push({ ...turn, at: this.now() });
    this.store.set(key, stored.slice(-this.maxTurns));

    if (this.store.size > 500) this.evictStale();
  }

  clear(key: string): void {
    this.store.delete(key);
  }

  private prune(turns: MemoryTurn[]): MemoryTurn[] {
    if (this.ttlMs <= 0) return turns;
    const now = this.now();
    return turns.filter((turn) => now - turn.at <= this.ttlMs);
  }

  /** 防止长期运行下 Map 无限增长：清理已过期的键 */
  private evictStale(): void {
    if (this.ttlMs <= 0) return;
    const now = this.now();
    for (const [key, turns] of this.store) {
      const lastAt = turns[turns.length - 1]?.at ?? 0;
      if (now - lastAt > this.ttlMs) this.store.delete(key);
    }
  }
}

/**
 * 决定这一问使用哪段上下文。
 *
 * 优先级：**自己的历史** > **群内上一轮**（可关闭）> 单轮问答。
 * 自己的历史优先，避免用户正在聊 A 时被群里刚聊过的 B 带偏。
 */
export function pickContext(
  own: MemoryTurn[],
  shared: MemoryTurn[],
  channelMemoryEnabled: boolean,
): { turns: MemoryTurn[]; inheritedFrom?: string } {
  if (own.length > 0) return { turns: own };
  if (!channelMemoryEnabled || shared.length === 0) return { turns: [] };
  return {
    turns: shared,
    inheritedFrom: shared[shared.length - 1].question,
  };
}
