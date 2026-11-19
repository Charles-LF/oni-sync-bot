import { Context, Service } from "koishi";
import { resolve } from "path";
import type { LocalIndex } from "vectra";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { VectorConfig } from "../config";
import { chunkText } from "../utils/renderText";
import { getErrorMessage, logger } from "../utils/tools";

declare module "koishi" {
  interface Context {
    vector: VectorService;
  }
}

/** 索引里每个文本块携带的元数据（id 形如 `页面标题#块序号`） */
export interface VectorChunkMetadata {
  [key: string]: string | number | boolean;
  documentId: string;
  title: string;
  url: string;
  chunkIndex: number;
  text: string;
}

/** 写入索引所需的页面内容 */
export interface VectorPage {
  /** 与 `wikitexts.id` 一致：页面标题 */
  id: string;
  title: string;
  url: string;
  text: string;
}

/** 一次检索命中的文本块 */
export interface VectorHit {
  documentId: string;
  title: string;
  url: string;
  text: string;
  score: number;
}

/** VectorService 对外暴露的最小能力，便于在单元测试里替换成替身 */
export interface VectorIndexer {
  indexPage(page: VectorPage): Promise<number>;
  removePage(documentId: string): Promise<void>;
}

/**
 * 本地向量库服务（`ctx.vector`）。
 *
 * 设计取舍（面向 2 核 2G 的小机器）：
 * - 索引是**纯文件**（vectra），不引入任何数据库进程；
 * - Embedding 用 transformers.js 在 CPU 上跑 `bge-small-zh`，不依赖外部 API；
 * - `vectra` 与 `@huggingface/transformers` 都是**按需动态加载**，
 *   功能没被用到时不会占用内存；
 * - 所有 Embedding 调用串行排队，避免小机器上并发推理把内存打满；
 * - 查询走同步接口，因此索引一旦加载过就会常驻（约几十 MB），这是有意的取舍。
 */
export class VectorService extends Service implements VectorIndexer {
  public static readonly inject = [];

  private readonly settings: VectorConfig;
  private indexPromise?: Promise<LocalIndex<VectorChunkMetadata>>;
  private embedderPromise?: Promise<FeatureExtractionPipeline>;
  /** 串行化 Embedding / 索引写入，避免并发推理 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: Context, config: VectorConfig) {
    super(ctx, "vector", true);
    this.settings = config;
  }

  get enabled(): boolean {
    return this.settings.vectorEnabled;
  }

  get indexPath(): string {
    return resolve(process.cwd(), this.settings.vectorIndexPath);
  }

  // ------------------------------------------------------------ 检索 / 写入

  /**
   * 把一个页面的纯文本切块、向量化并写入索引（同标题的旧块会被替换）。
   * @returns 写入的文本块数量
   */
  async indexPage(page: VectorPage): Promise<number> {
    if (!this.enabled) return 0;

    return this.enqueue(async () => {
      const chunks = chunkText(page.text, {
        size: this.settings.chunkSize,
        overlap: this.settings.chunkOverlap,
        maxChunks: this.settings.maxChunksPerPage,
      });

      const index = await this.getIndex();
      await this.deleteChunks(index, page.id);
      if (chunks.length === 0) return 0;

      const items: Array<{
        id: string;
        vector: number[];
        metadata: VectorChunkMetadata;
      }> = [];

      const batchSize = Math.max(1, this.settings.embedBatchSize);
      for (let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize);
        const vectors = await this.embed(batch.map((chunk) => chunk.text));
        batch.forEach((chunk, offset) => {
          const vector = vectors[offset];
          if (!vector) return;
          items.push({
            id: `${page.id}#${chunk.index}`,
            vector,
            metadata: {
              documentId: page.id,
              title: page.title,
              url: page.url,
              chunkIndex: chunk.index,
              text: chunk.text,
            },
          });
        });
      }

      if (items.length === 0) return 0;
      await index.batchInsertItems(items);
      logger.debug(`[vector] ${page.title}：写入 ${items.length} 个文本块`);
      return items.length;
    });
  }

  /** 删除某个页面的全部文本块 */
  async removePage(documentId: string): Promise<void> {
    if (!this.enabled) return;
    await this.enqueue(async () => {
      const index = await this.getIndex();
      await this.deleteChunks(index, documentId);
    });
  }

  /**
   * 语义检索：返回最相关的若干文本块。
   *
   * 不做「同一页面最多 N 块」的截断：实测「电解器耗电多少」时，
   * 含 `电力：消耗 120 瓦` 的信息框块稳定排在第 4，若按页面去重就会被裁掉，
   * 模型只能回答「未提及」。宁可多给几块同页内容，也不能漏掉唯一的数据块。
   */
  async search(
    question: string,
    topK: number = this.settings.retrieveTopK,
    filter?: Record<string, string | number | boolean>,
  ): Promise<VectorHit[]> {
    const keyword = question.trim();
    if (!this.enabled || !keyword) return [];

    const index = await this.getIndex();
    if (!(await index.isIndexCreated())) return [];
    const stats = await index.getIndexStats();
    if (stats.items === 0) return [];

    const query = `${this.settings.queryInstruction}${keyword}`.trim();
    const [vector] = await this.enqueue(() => this.embed([query]));
    if (!vector) return [];

    const candidates = await index.queryItems<VectorChunkMetadata>(
      vector,
      keyword,
      Math.max(topK * 2, topK),
      filter,
      false,
    );

    const hits: VectorHit[] = [];
    for (const candidate of candidates) {
      if (candidate.score < this.settings.retrieveMinScore) continue;

      const { documentId, title, url, text } = candidate.item.metadata;
      if (!documentId || !text) continue;

      hits.push({
        documentId,
        title: title || documentId,
        url: url || "",
        text,
        score: candidate.score,
      });
      if (hits.length >= topK) break;
    }

    return hits;
  }

  /** 索引现状，供 `.ai.status` 与日志使用 */
  async stats(): Promise<{
    enabled: boolean;
    path: string;
    items: number;
    bytes: number;
  }> {
    if (!this.enabled) {
      return { enabled: false, path: this.indexPath, items: 0, bytes: 0 };
    }
    const index = await this.getIndex();
    const created = await index.isIndexCreated();
    const items = created ? (await index.getIndexStats()).items : 0;

    let bytes = 0;
    try {
      const { stat } = await import("node:fs/promises");
      bytes = (await stat(resolve(index.folderPath, index.indexName))).size;
    } catch {
      bytes = 0;
    }

    return { enabled: true, path: index.folderPath, items, bytes };
  }

  /**
   * 直接按「页面 + 块序号」取块（不参与相似度排序）。
   *
   * 追问场景用它把当前话题页的**第 0 块（信息框/简介）**钉进上下文：
   * 这类块里是耗电、产热、尺寸等单点数值，实测相似度只能排到第 4~5，
   * 靠排名召回很脆弱，直接取更可靠。
   */
  async getChunk(
    documentId: string,
    chunkIndex = 0,
  ): Promise<VectorHit | undefined> {
    if (!this.enabled || !documentId) return undefined;

    const index = await this.getIndex();
    if (!(await index.isIndexCreated())) return undefined;

    const item = await index.getItem<VectorChunkMetadata>(
      `${documentId}#${chunkIndex}`,
    );
    if (!item?.metadata?.text) return undefined;

    return {
      documentId,
      title: item.metadata.title || documentId,
      url: item.metadata.url || "",
      text: item.metadata.text,
      score: 1,
    };
  }

  /**
   * 取某页的全部文本块（按块序号排序）。
   *
   * 「电解器能干哈」这类宽泛问题，光靠相似度只能拿到页面的几段（电解器页共 12 块、
   * 约 3000 字），提示词里塞得下整页，因此由调用方按字符预算决定补多少。
   */
  async listPageChunks(documentId: string): Promise<VectorHit[]> {
    if (!this.enabled || !documentId) return [];

    const index = await this.getIndex();
    if (!(await index.isIndexCreated())) return [];

    const items = await index.listItemsByMetadata<VectorChunkMetadata>({
      documentId,
    });
    return items
      .filter((item) => item.metadata?.text)
      .sort(
        (a, b) =>
          (a.metadata.chunkIndex ?? 0) - (b.metadata.chunkIndex ?? 0),
      )
      .map((item) => ({
        documentId,
        title: item.metadata.title || documentId,
        url: item.metadata.url || "",
        text: item.metadata.text,
        score: 1,
      }));
  }

  /** 清空索引（重建前调用） */
  async reset(): Promise<void> {
    if (!this.enabled) return;
    await this.enqueue(async () => {
      const index = await this.getIndex();
      await index.deleteIndex();
      this.indexPromise = undefined;
      logger.info(`[vector] 索引已清空：${this.indexPath}`);
    });
  }

  /** 插件卸载时释放模型，避免热重载反复占用内存 */
  async stop(): Promise<void> {
    this.indexPromise = undefined;
    const embedder = this.embedderPromise;
    this.embedderPromise = undefined;
    if (!embedder) return;
    try {
      const extractor = await embedder;
      await extractor.dispose?.();
    } catch (error) {
      logger.debug(`[vector] 释放 Embedding 模型失败：${getErrorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------- 内部实现

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getIndex(): Promise<LocalIndex<VectorChunkMetadata>> {
    if (!this.indexPromise) {
      const promise = (async () => {
        const { LocalIndex } = await import("vectra");
        const index = new LocalIndex<VectorChunkMetadata>(this.indexPath);
        if (!(await index.isIndexCreated())) {
          // 不声明 metadata_config.indexed：元数据（含正文片段）直接内联在 index.json 里，
          // 避免每个文本块生成一个独立的小文件。
          await index.createIndex({ version: 1 });
          logger.info(`[vector] 已创建向量索引：${index.folderPath}`);
        }
        return index;
      })();

      this.indexPromise = promise;
      promise.catch(() => {
        if (this.indexPromise === promise) this.indexPromise = undefined;
      });
    }
    return this.indexPromise;
  }

  private getEmbedder(): Promise<FeatureExtractionPipeline> {
    if (!this.embedderPromise) {
      const promise = (async () => {
        const transformers = await import("@huggingface/transformers");
        const { env } = transformers;
        if (this.settings.embeddingRemoteHost) {
          env.remoteHost = this.settings.embeddingRemoteHost;
        }
        if (this.settings.embeddingCacheDir) {
          env.cacheDir = resolve(process.cwd(), this.settings.embeddingCacheDir);
        }

        logger.info(
          `[vector] 加载 Embedding 模型 ${this.settings.embeddingModel}（首次运行会自动下载）`,
        );
        const extractor = await transformers.pipeline(
          "feature-extraction",
          this.settings.embeddingModel,
          {
            device: "cpu",
            dtype: this.settings.embeddingDtype,
          },
        );
        logger.info("[vector] Embedding 模型加载完成");
        return extractor;
      })();

      this.embedderPromise = promise;
      promise.catch(() => {
        if (this.embedderPromise === promise) this.embedderPromise = undefined;
      });
    }
    return this.embedderPromise;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getEmbedder();
    const output = await extractor(texts, {
      pooling: "mean",
      normalize: true,
    });

    const [batch, dimension] = output.dims as number[];
    const data = output.data as unknown as Float32Array;
    const vectors: number[][] = [];
    for (let i = 0; i < batch; i++) {
      vectors.push(Array.from(data.subarray(i * dimension, (i + 1) * dimension)));
    }
    return vectors;
  }

  private async deleteChunks(
    index: LocalIndex<VectorChunkMetadata>,
    documentId: string,
  ): Promise<void> {
    const existing = await index.listItemsByMetadata<VectorChunkMetadata>({
      documentId,
    });
    if (existing.length === 0) return;
    await index.deleteItems(existing.map((item) => item.id));
  }
}
