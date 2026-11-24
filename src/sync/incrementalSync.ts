/**
 * 兼容层（P0 迁移）：增量同步用例已迁到 `application/sync/incrementalSyncUseCase.ts`。
 *
 * 保留这个入口是为了不打断既有调用方（命令、外部脚本、测试）；
 * 新代码请直接 import 应用层用例，不要继续往这里加逻辑。
 */
export {
  IncrementalSyncUseCase,
  runIncrementalSync,
} from "../application/sync/incrementalSyncUseCase";
export type {
  IncrementalSyncDeps,
  IncrementalSyncOptions,
  IncrementalSyncResult,
} from "../application/sync/incrementalSyncUseCase";
