/** 一轮短期记忆：问题、回答，以及当轮查过的页面（供追问兜底） */
export interface MemoryTurn {
  question: string;
  answer: string;
  /** 这一轮检索到的页面标题；空表示没查到 */
  page?: string;
  at: number;
}

/**
 * `.ai` 的短期记忆（内存 Map，落库由调用方负责）。
 * `maxTurns <= 0` 关闭；超过 `ttlMs` 视为新话题；重启恢复靠 `restore()`。
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

  /** 从数据库恢复某个键的记忆（重启后内存为空时用），同样做 TTL 与轮数裁剪 */
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

  /** 防止长期运行下 Map 无限膨胀：清掉过期的键 */
  private evictStale(): void {
    if (this.ttlMs <= 0) return;
    const now = this.now();
    for (const [key, turns] of this.store) {
      const lastAt = turns[turns.length - 1]?.at ?? 0;
      if (now - lastAt > this.ttlMs) this.store.delete(key);
    }
  }
}

/** 选上下文：自己的历史 > 群内上一轮（可关闭）> 单轮 */
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
