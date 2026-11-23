import { Mwn } from "mwn";
import { sleep } from "../utils/async";
import fetch from "node-fetch";
import FormData from "form-data";
import {
  logger,
  getErrorMessage,
  normalizeImageTitle,
  stripImagePrefix,
} from "../utils/tools";
import type {
  SyncLoopHooks,
  SyncLoopResult,
} from "./hooks";
import { ABORT_ERROR_NAME } from "./hooks";

/** 图片同步的可调参数 */
export interface ImageSyncOptions {
  /** 忽略的图片名 */
  ignoredImages: string[];
  /** 同步成功后等待毫秒数 */
  intervalSuccess: number;
  /** 同步失败后等待毫秒数 */
  intervalFailed: number;
  /** 上传时的注释 */
  uploadComment: string;
  /** 上传时的授权说明文本 */
  uploadText: string;
}

const DEFAULT_OPTIONS: ImageSyncOptions = {
  ignoredImages: [],
  intervalSuccess: 3000,
  intervalFailed: 5000,
  uploadComment: "从 WikiGG 自动同步转存",
  uploadText: "== 授权说明 ==\n本文件从 WikiGG 转存，遵循原站点授权协议。",
};

export interface SyncResult {
  success: boolean;
  reason?: string;
}

interface ImageInfo {
  url: string;
  sha1: string;
  size?: number;
}

interface QueryPage {
  pageid?: number;
  title: string;
  missing?: boolean;
  imageinfo?: ImageInfo[];
}

interface RevisionItem {
  revid: number;
}

interface RevisionPage {
  revisions?: RevisionItem[];
}

interface AllImageItem {
  title: string;
}

/** 与 PageSyncer / ModuleSyncer 保持一致的构造签名 */
export interface ImageSyncerDependencies {
  options?: Partial<ImageSyncOptions>;
}

/**
 * 把 wiki.gg 的图片文件同步到 bwiki。
 * 依赖全部由构造函数注入，可安全地实例化多份。
 */
export class ImageSyncer {
  private readonly options: ImageSyncOptions;

  constructor(
    private readonly source: Mwn,
    private readonly target: Mwn,
    deps: ImageSyncerDependencies = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
  }

  async getImageInfo(site: Mwn, fileName: string): Promise<ImageInfo | null> {
    try {
      const normalizedTitle = normalizeImageTitle(fileName);
      const response = await site.query({
        action: "query",
        titles: normalizedTitle,
        prop: "imageinfo",
        iiprop: "url|sha1|size|mime",
      });

      const pages = (response.query?.pages || {}) as Record<
        string,
        QueryPage
      >;
      const page = Object.values(pages)[0];

      if (
        !page ||
        page.missing ||
        !page.imageinfo ||
        page.imageinfo.length === 0
      ) {
        return null;
      }

      const imageInfo = page.imageinfo[0];
      return {
        url: imageInfo.url,
        sha1: imageInfo.sha1,
        size: imageInfo.size,
      };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      logger.error(`[GetImageInfo] 获取 ${fileName} 信息失败:`, errorMsg);
      return null;
    }
  }

  private async deleteOldVersions(
    bot: Mwn,
    fileName: string,
  ): Promise<void> {
    try {
      const normalizedTitle = normalizeImageTitle(fileName);
      const response = await bot.query({
        action: "query",
        titles: normalizedTitle,
        prop: "revisions",
        rvprop: "ids|timestamp",
        rvlimit: "max",
        rvdir: "newer", // 按时间正序排列，最新的在最后
      });

      const pages = (response.query?.pages || {}) as Record<
        string,
        RevisionPage
      >;
      const page = Object.values(pages)[0];

      // 没有旧版本或只有一个版本，无需删除
      if (!page || !page.revisions || page.revisions.length <= 1) {
        return;
      }

      // 除最后一项（最新版本）外全部删除
      const revisionIds = page.revisions.slice(0, -1).map((rev) => rev.revid);

      const token = await bot.getCsrfToken();

      for (const revid of revisionIds) {
        try {
          await bot.rawRequest({
            method: "POST",
            url: bot.options.apiUrl as string,
            data: {
              action: "delete",
              title: fileName,
              revid,
              token,
              reason: "自动清理旧版本，只保留最新同步版本",
              format: "json",
            },
          });
          logger.info(`[SyncImg] 🗑️ 删除旧版本 ${revid} 成功`);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          logger.error(`[SyncImg] ❌ 删除旧版本 ${revid} 失败:`, errorMsg);
          // 继续处理其他版本，不中断流程
        }
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      logger.error(`[SyncImg] ❌ 获取版本信息失败:`, errorMsg);
    }
  }

  async syncOne(fileName: string): Promise<SyncResult> {
    if (this.options.ignoredImages.includes(fileName)) {
      logger.info(`[SyncImg] 🚫 图片 ${fileName} 在忽略列表，跳过`);
      return { success: true, reason: "ignored" };
    }

    const bareFileName = stripImagePrefix(fileName);

    try {
      logger.info(`[SyncImg] 🚀 开始处理: ${bareFileName}`);

      // 获取源站图片信息
      const sourceImageInfo = await this.getImageInfo(this.source, bareFileName);
      if (!sourceImageInfo) {
        logger.info(`[SyncImg] ❌ 源站未找到图片: ${fileName}`);
        return { success: false, reason: "source_missing" };
      }

      // 哈希校验
      const targetImageInfo = await this.getImageInfo(this.target, bareFileName);
      logger.info(`原图片sha1: ${sourceImageInfo.sha1}`);
      logger.info(`目标图片sha1: ${targetImageInfo?.sha1}`);
      if (targetImageInfo && targetImageInfo.sha1 === sourceImageInfo.sha1) {
        logger.info(`[SyncImg] 🟡 图片 ${fileName} 已存在且内容一致，跳过`);
        return { success: true, reason: "no_change" };
      }

      // 下载图片到内存
      logger.info(`[SyncImg] 📥 下载图片: ${sourceImageInfo.url}`);
      const imageResponse = await fetch(sourceImageInfo.url, {
        headers: {
          "User-Agent": "OniSyncBot/1.0 (https://klei.vip; Charles@klei.vip)",
        },
      });

      if (!imageResponse.ok) {
        throw new Error(`图片下载失败，HTTP状态码: ${imageResponse.status}`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      logger.info(
        `[SyncImg] 📤 上传图片: ${bareFileName} (大小: ${(imageBuffer.length / 1024).toFixed(1)} KB)`,
      );

      const token = await this.target.getCsrfToken();
      const form = new FormData();

      form.append("action", "upload");
      form.append("filename", bareFileName);
      form.append("text", this.options.uploadText);
      form.append("comment", this.options.uploadComment);
      form.append("token", token);
      form.append("ignorewarnings", "0");
      form.append("format", "json");

      form.append("file", imageBuffer, {
        filename: bareFileName,
        contentType:
          imageResponse.headers.get("content-type") ||
          "application/octet-stream",
      });

      const rawResponse = await this.target.rawRequest({
        method: "POST",
        url: this.target.options.apiUrl as string,
        data: form,
        headers: {
          ...form.getHeaders(),
        },
      });

      const responseData = rawResponse.data;
      if (responseData.upload && responseData.upload.result === "Success") {
        logger.info(`[SyncImg] ✅ 图片 ${fileName} 同步成功`);

        // 删除旧版本
        await this.deleteOldVersions(this.target, fileName);

        return { success: true, reason: "synced" };
      } else if (responseData.error) {
        throw new Error(`${responseData.error.code}: ${responseData.error.info}`);
      } else {
        throw new Error(`未知响应: ${JSON.stringify(responseData)}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("fileexists-no-change")
      ) {
        logger.info(`[SyncImg] 🟡 图片 ${fileName} 已存在且内容相同，跳过`);
        return { success: true, reason: "no_change" };
      }
      const errMsg = getErrorMessage(error);
      logger.error(`[SyncImg] ❌ 图片 ${fileName} 同步失败:`, errMsg);
      return { success: false, reason: errMsg };
    }
  }

  async listAll(): Promise<string[]> {
    logger.info(`[SyncAllImg] 📥 开始获取WikiGG所有图片`);
    const allImages: string[] = [];

    const queryGen = this.source.continuedQueryGen({
      action: "query",
      list: "allimages",
      ailimit: "max",
      aidir: "ascending",
      ainamespace: 6,
    });

    for await (const res of queryGen) {
      const imageItems = (res.query?.allimages || []) as AllImageItem[];
      allImages.push(...imageItems.map((img) => img.title));
      logger.info(`[SyncAllImg] 📄 已获取 ${allImages.length} 个图片`);
    }

    logger.info(`[SyncAllImg] 📊 总计获取到 ${allImages.length} 个图片`);
    return allImages;
  }

  /** 批量同步所有图片：先串行同步一轮，再重试失败的 */
  async syncAll(hooks: SyncLoopHooks = {}): Promise<SyncLoopResult> {
    const emit = (info: Partial<Parameters<NonNullable<SyncLoopHooks["onProgress"]>>[0]>) =>
      hooks.onProgress?.({
        phase: "同步图片",
        current: 0,
        total: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
        ...info,
      });

    try {
      emit({ phase: "列举图片" });
      const imageList = await this.listAll();
      if (imageList.length === 0) {
        logger.info(`[SyncAllImg] 📭 源站无图片可同步，结束`);
        return { total: 0, synced: 0, skipped: 0, failed: 0 };
      }

      let successCount = 0;
      let failCount = 0;
      let skipCount = 0;
      const failedImages: string[] = [];

      logger.info(
        `[SyncAllImg] 🚦 开始批量同步，总计 ${imageList.length} 个图片`,
      );

      for (let i = 0; i < imageList.length; i++) {
        await hooks.checkpoint?.();
        const fileName = imageList[i];
        const progress = ((i + 1) / imageList.length) * 100;

        logger.info(
          `\n[SyncAllImg] 📈 进度 ${i + 1}/${imageList.length} (${progress.toFixed(1)}%)`,
        );
        const result = await this.syncOne(fileName);

        if (!result.success) {
          failCount++;
          failedImages.push(fileName);
          await sleep(this.options.intervalFailed);
        } else {
          successCount++;
          if (result.reason === "ignored" || result.reason === "no_change") {
            skipCount++;
          }
          await sleep(this.options.intervalSuccess);
        }

        emit({
          current: i + 1,
          total: imageList.length,
          title: stripImagePrefix(fileName),
          synced: successCount - skipCount,
          skipped: skipCount,
          failed: failCount,
        });
      }

      if (failedImages.length > 0) {
        logger.info(
          `\n[SyncAllImg] 🔄 开始重试 ${failedImages.length} 个失败图片`,
        );
        const stillFailed: string[] = [];

        for (const fileName of failedImages) {
          await hooks.checkpoint?.();
          logger.info(`\n[SyncAllImg] 🔁 重试: ${fileName}`);
          const result = await this.syncOne(fileName);

          if (result.success) {
            successCount++;
            failCount--;
            logger.info(`[SyncAllImg] ✅ 重试成功: ${fileName}`);
          } else {
            stillFailed.push(fileName);
            logger.info(`[SyncAllImg] ❌ 重试失败: ${fileName}`);
          }
          await sleep(this.options.intervalSuccess);
        }

        if (stillFailed.length > 0) {
          logger.info(`\n[SyncAllImg] ❌ 最终失败列表（需手动处理）:`);
          stillFailed.forEach((title, idx) =>
            logger.info(`  ${idx + 1}. ${title}`),
          );
        } else {
          logger.info(`\n[SyncAllImg] 🎉 所有失败图片重试成功！`);
        }
      }

      logger.info(`\n[SyncAllImg] 📊 同步完成！`);
      logger.info(`├─ 总计：${imageList.length} 个图片`);
      logger.info(`├─ 成功：${successCount} 个（含跳过 ${skipCount} 个）`);
      logger.info(`└─ 失败：${failCount} 个`);

      return {
        total: imageList.length,
        synced: successCount - skipCount,
        skipped: skipCount,
        failed: failCount,
      };
    } catch (globalError) {
      if (globalError instanceof Error && globalError.name === ABORT_ERROR_NAME) {
        throw globalError;
      }
      logger.error(`[SyncAllImg] 💥 同步流程异常终止:`, globalError);
      throw globalError;
    }
  }
}
