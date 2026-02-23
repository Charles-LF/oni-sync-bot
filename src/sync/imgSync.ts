import { Mwn } from "mwn";
import { sleep } from "koishi";
import fetch from "node-fetch";
import FormData from "form-data";
import { Config } from "../index";
import { getSitesConfig } from "../config";

// 配置项
export const CONFIG = {
  IGNORED_IMAGES: [],
  SYNC_INTERVAL_SUCCESS: 3000,
  SYNC_INTERVAL_FAILED: 5000,
  UPLOAD_COMMENT: "从 WikiGG 自动同步转存",
  UPLOAD_TEXT: "== 授权说明 ==\n本文件从 WikiGG 转存，遵循原站点授权协议。",
};

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

/**
 * 获取图片的原始URL和SHA1
 */
async function getImageInfo(
  site: Mwn,
  fileName: string,
): Promise<ImageInfo | null> {
  try {
    const response = await site.query({
      action: "query",
      titles: fileName,
      prop: "imageinfo",
      iiprop: "url|sha1|size|mime",
    });

    const pages = (response.query?.pages || {}) as Record<string, QueryPage>;
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
    console.error(`[GetImageInfo] 获取 ${fileName} 信息失败:`, error);
    return null;
  }
}

/**
 * 同步单个图片（使用 rawRequest 修复 JSON 解析问题）
 */
async function syncSingleImage(
  sourceBot: Mwn,
  targetBot: Mwn,
  fileName: string,
  config: Config,
): Promise<{ success: boolean; reason?: string }> {
  if (CONFIG.IGNORED_IMAGES.includes(fileName)) {
    console.log(`[SyncImg] 🚫 图片 ${fileName} 在忽略列表，跳过`);
    return { success: true, reason: "ignored" };
  }

  try {
    console.log(`[SyncImg] 🚀 开始处理: ${fileName}`);

    // 1. 获取源站图片信息
    const sourceImageInfo = await getImageInfo(sourceBot, fileName);
    if (!sourceImageInfo) {
      console.log(`[SyncImg] ❌ 源站未找到图片: ${fileName}`);
      return { success: false, reason: "source_missing" };
    }

    // 2. 哈希校验
    const targetImageInfo = await getImageInfo(targetBot, fileName);
    if (targetImageInfo && targetImageInfo.sha1 === sourceImageInfo.sha1) {
      console.log(`[SyncImg] 🟡 图片 ${fileName} 已存在且内容一致，跳过`);
      return { success: true, reason: "no_change" };
    }

    // 3. 下载图片到内存
    console.log(`[SyncImg] 📥 下载图片: ${sourceImageInfo.url}`);
    const imageResponse = await fetch(sourceImageInfo.url, {
      headers: {
        "User-Agent": "OniSyncBot/1.0 (https://klei.vip; Charles@klei.vip)",
      },
    });

    if (!imageResponse.ok) {
      throw new Error(`图片下载失败，HTTP状态码: ${imageResponse.status}`);
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    console.log(
      `[SyncImg] 📤 上传图片: ${fileName} (大小: ${(imageBuffer.length / 1024).toFixed(1)} KB)`,
    );

    // 4. 核心修复：使用 rawRequest + FormData
    const token = await targetBot.getCsrfToken();
    const form = new FormData();

    form.append("action", "upload");
    form.append("filename", fileName);
    form.append("text", CONFIG.UPLOAD_TEXT);
    form.append("comment", CONFIG.UPLOAD_COMMENT);
    form.append("token", token);
    form.append("ignorewarnings", "1");
    form.append("format", "json");

    form.append("file", imageBuffer, {
      filename: fileName.split(":").pop() || fileName,
      contentType:
        imageResponse.headers.get("content-type") || "application/octet-stream",
    });

    // 使用 rawRequest，完全手动控制
    const rawResponse = await targetBot.rawRequest({
      method: "POST",
      url: targetBot.options.apiUrl as string,
      data: form,
      headers: {
        ...form.getHeaders(),
        "X-authkey": `${getSitesConfig(config).huiji.uakey}`,
      },
    });

    // 手动解析响应
    const responseData = rawResponse.data;
    if (responseData.upload && responseData.upload.result === "Success") {
      console.log(`[SyncImg] ✅ 图片 ${fileName} 同步成功`);
      return { success: true, reason: "synced" };
    } else if (responseData.error) {
      throw new Error(`${responseData.error.code}: ${responseData.error.info}`);
    } else {
      throw new Error(`未知响应: ${JSON.stringify(responseData)}`);
    }
  } catch (error) {
    const errMsg = (error as Error).message || String(error);
    console.error(`[SyncImg] ❌ 图片 ${fileName} 同步失败:`, errMsg);
    return { success: false, reason: errMsg };
  }
}

/**
 * 获取源站所有图片列表
 */
async function getAllImages(site: Mwn): Promise<string[]> {
  console.log(`[SyncAllImg] 📥 开始获取WikiGG所有图片`);
  const allImages: string[] = [];

  interface AllImageItem {
    title: string;
  }

  const queryGen = site.continuedQueryGen({
    action: "query",
    list: "allimages",
    ailimit: "max",
    aidir: "ascending",
    ainamespace: 6,
  });

  for await (const res of queryGen) {
    const imageItems = (res.query?.allimages || []) as AllImageItem[];
    const imageTitles = imageItems.map((img) => img.title);
    allImages.push(...imageTitles);
    console.log(`[SyncAllImg] 📄 已获取 ${allImages.length} 个图片`);
  }

  console.log(`[SyncAllImg] 📊 总计获取到 ${allImages.length} 个图片`);
  return allImages;
}

/**
 * 批量同步所有图片（带失败重试）
 */
async function syncAllImages(
  sourceBot: Mwn,
  targetBot: Mwn,
  config: Config,
): Promise<void> {
  try {
    const imageList = await getAllImages(sourceBot);
    if (imageList.length === 0) {
      console.log(`[SyncAllImg] 📭 源站无图片可同步，结束`);
      return;
    }

    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    const failedImages: string[] = [];

    console.log(
      `[SyncAllImg] 🚦 开始批量同步，总计 ${imageList.length} 个图片`,
    );

    for (let i = 0; i < imageList.length; i++) {
      const fileName = imageList[i];
      const progress = ((i + 1) / imageList.length) * 100;

      console.log(
        `\n[SyncAllImg] 📈 进度 ${i + 1}/${imageList.length} (${progress.toFixed(1)}%)`,
      );
      const result = await syncSingleImage(
        sourceBot,
        targetBot,
        fileName,
        config,
      );

      if (!result.success) {
        failCount++;
        failedImages.push(fileName);
        await sleep(CONFIG.SYNC_INTERVAL_FAILED);
      } else {
        successCount++;
        if (result.reason === "ignored" || result.reason === "no_change") {
          skipCount++;
        }
        await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
      }
    }

    if (failedImages.length > 0) {
      console.log(
        `\n[SyncAllImg] 🔄 开始重试 ${failedImages.length} 个失败图片`,
      );
      const stillFailed: string[] = [];

      for (const fileName of failedImages) {
        console.log(`\n[SyncAllImg] 🔁 重试: ${fileName}`);
        const result = await syncSingleImage(
          sourceBot,
          targetBot,
          fileName,
          config,
        );

        if (result.success) {
          successCount++;
          failCount--;
          console.log(`[SyncAllImg] ✅ 重试成功: ${fileName}`);
        } else {
          stillFailed.push(fileName);
          console.log(`[SyncAllImg] ❌ 重试失败: ${fileName}`);
        }
        await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
      }

      if (stillFailed.length > 0) {
        console.log(`\n[SyncAllImg] ❌ 最终失败列表（需手动处理）:`);
        stillFailed.forEach((title, idx) =>
          console.log(`  ${idx + 1}. ${title}`),
        );
      } else {
        console.log(`\n[SyncAllImg] 🎉 所有失败图片重试成功！`);
      }
    }

    console.log(`\n[SyncAllImg] 📊 同步完成！`);
    console.log(`├─ 总计：${imageList.length} 个图片`);
    console.log(`├─ 成功：${successCount} 个（含跳过 ${skipCount} 个）`);
    console.log(`└─ 失败：${failCount} 个`);
  } catch (globalError) {
    console.error(`[SyncAllImg] 💥 同步流程异常终止:`, globalError);
    throw globalError;
  }
}

export { syncSingleImage, syncAllImages, getImageInfo };
