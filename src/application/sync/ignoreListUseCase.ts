import {
  IGNORE_TYPES,
  isIgnoreType,
  normalizeIgnoreName,
  type IgnoreRule,
  type IgnoreType,
  type StoredIgnoreRule,
} from "../../domain/sync/ignoreRule";

/**
 * 忽略列表的仓储端口：应用层只依赖这 4 个方法，
 * 具体实现见 `infrastructure/persistence/syncIgnoreRepository.ts`。
 */
export interface IgnoreRuleRepositoryPort {
  list(type?: IgnoreType): Promise<StoredIgnoreRule[]>;
  find(type: IgnoreType, name: string): Promise<StoredIgnoreRule | undefined>;
  insert(rule: IgnoreRule): Promise<StoredIgnoreRule>;
  delete(type: IgnoreType, name: string): Promise<number>;
}

export class InvalidIgnoreTypeError extends Error {
  constructor(readonly value: string) {
    super(`类型只能是 ${IGNORE_TYPES.join(" / ")}，收到「${value || "空"}」`);
    this.name = "InvalidIgnoreTypeError";
  }
}

export class EmptyIgnoreNameError extends Error {
  constructor() {
    super("名称不能为空");
    this.name = "EmptyIgnoreNameError";
  }
}

export class DuplicateIgnoreRuleError extends Error {
  constructor(readonly existing: StoredIgnoreRule) {
    super(
      `已存在同名规则：${existing.type}/${existing.name}` +
        (existing.reason ? `（原因：${existing.reason}）` : ""),
    );
    this.name = "DuplicateIgnoreRuleError";
  }
}

export class IgnoreRuleNotFoundError extends Error {
  constructor(type: string, name: string) {
    super(`没有找到规则：${type}/${name}`);
    this.name = "IgnoreRuleNotFoundError";
  }
}

/**
 * 忽略列表用例（应用层）：负责参数校验、归一化与查重，
 * 命令层与控制台 API 都复用它，保证两条入口的行为一致。
 */
export class IgnoreListUseCase {
  constructor(private readonly repo: IgnoreRuleRepositoryPort) {}

  async list(type?: string): Promise<StoredIgnoreRule[]> {
    if (type === undefined || type === "") return this.repo.list();
    return this.repo.list(parseType(type));
  }

  async add(input: {
    type: string;
    name: string;
    reason?: string;
  }): Promise<StoredIgnoreRule> {
    const type = parseType(input.type);
    const name = (input.name ?? "").trim();
    if (!normalizeIgnoreName(type, name)) throw new EmptyIgnoreNameError();

    const existing = await this.repo.find(type, name);
    if (existing) throw new DuplicateIgnoreRuleError(existing);

    return this.repo.insert({
      type,
      name,
      reason: (input.reason ?? "").trim(),
    });
  }

  async remove(input: { type: string; name: string }): Promise<string> {
    const type = parseType(input.type);
    const name = (input.name ?? "").trim();
    if (!normalizeIgnoreName(type, name)) throw new EmptyIgnoreNameError();

    const removed = await this.repo.delete(type, name);
    if (removed === 0) throw new IgnoreRuleNotFoundError(type, name);
    return `已移除忽略规则 ${type}/${name}`;
  }
}

function parseType(value: string): IgnoreType {
  const type = (value ?? "").trim().toLowerCase();
  if (!isIgnoreType(type)) throw new InvalidIgnoreTypeError(value);
  return type;
}
