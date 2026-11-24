import { Bot, Context } from "koishi";
import type { SyncNotifyItem } from "../sync/pageSync";
import {
  formatWikiTime,
  getErrorMessage,
  logger,
  normalizeChannelId,
  truncateComment,
} from "../utils/tools";

/**
 * 把增量更新中同步成功的条目合并成一条消息，推送到配置的群频道。
 *
 * 未配置 `groupIds` 时视为关闭（`enabled` 为 false）：调用方据此不注册回调，
 * 避免在不使用通知时仍然产生「找不到可用 bot」之类的告警。
 */
export class SyncNotifier {
  private readonly groupIds: string[];
  private readonly platform: string;

  constructor(
    private readonly ctx: Context,
    groupIds: string[] = [],
    platform = "qq",
  ) {
    this.groupIds = groupIds;
    this.platform = platform || "qq";
  }

  get enabled(): boolean {
    return this.groupIds.length > 0;
  }

  async notify(items: SyncNotifyItem[]): Promise<void> {
    if (items.length === 0) return;

    try {
      const bots = this.activeBots();
      if (bots.length === 0) {
        logger.warn(
          `[通知] 未找到可用的 ${this.platform} 平台 bot，跳过群通知`,
        );
        return;
      }

      const message = this.formatMessage(items);

      for (const bot of bots) {
        for (const rawChannelId of this.groupIds) {
          const channelId = normalizeChannelId(rawChannelId);
          if (!channelId) continue;

          try {
            await bot.sendMessage(channelId, message);
            logger.info(
              `[通知] 向 ${bot.platform}/${channelId} 推送成功 (${items.length} 条)`,
            );
          } catch (error) {
            logger.error(
              `[通知] 向 ${bot.platform}/${channelId} 发送消息失败:`,
              getErrorMessage(error),
            );
          }
        }
      }
    } catch (error) {
      logger.error(`[通知] 处理通知过程出错:`, getErrorMessage(error));
    }
  }

  private activeBots(): Bot[] {
    const bots: Bot[] = [];
    for (const bot of this.ctx.bots) {
      if (bot.platform === this.platform && bot.isActive) {
        bots.push(bot);
      }
    }
    return bots;
  }

  private formatMessage(items: SyncNotifyItem[]): string {
    const lines: string[] = [`Wiki 同步更新（${items.length} 条）`, ""];

    items.forEach((item, index) => {
      const time = item.timestamp ? formatWikiTime(item.timestamp) : "";
      if (item.type === "image") {
        // 图片没有编辑者，只标时间，避免出现「未知｜」
        lines.push(`🖼️ ${index + 1}. ${item.title}${time ? `｜${time}` : ""}`);
        return;
      }
      const user = item.user || "未知";
      const summary = truncateComment(item.comment || "", 10);
      const commentPart = summary ? `｜${summary}` : "";
      lines.push(
        `📖 ${index + 1}. ${item.title}｜${user}｜${time}${commentPart}`,
      );
    });

    return lines.join("\n");
  }
}
