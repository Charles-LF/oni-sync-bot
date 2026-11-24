import { Context, Session } from "koishi";
import type { MatchResult } from "../utils/matcher";

export interface LinkButton {
  id: string;
  render_data: {
    label: string;
    visited_label: string;
    style: number;
  };
  action: {
    type: number;
    permission: { type: number };
    data: string;
  };
}

/** QQ 键盘（按钮组） */
export interface Keyboard {
  content: {
    rows: Array<{ buttons: LinkButton[] }>;
  };
}

/** 渲染页面信息所需的最小结构（WikiPages 结构上兼容） */
export interface RenderablePage {
  id: number;
  title: string;
  contributor?: string;
  change_time?: string;
}

/**
 * QQ 适配器在 session 上暴露、但不在 Koishi 公共类型里的字段。
 * 只在真正需要发 QQ Markdown 时做一次窄化转换，避免把整个 session 标成 any。
 */
interface QQSession {
  messageId: string;
  channelId: string;
  bot: {
    internal: {
      sendMessage(channelId: string, payload: unknown): Promise<unknown>;
    };
  };
}

const QQ_STYLE_ROW_SEPARATOR = "---\n";

/**
 * 负责“把回复内容按平台渲染并发送”。
 *
 * 平台差异集中在这里：
 * - **QQ**：走 markdown + 按钮键盘，通过 `bot.internal.sendMessage` 主动发送，
 *   成功后命令不再返回内容；发送失败则降级为返回纯文本。
 * - **其它平台**：只返回纯文本，由 Koishi 作为命令返回值发送。
 */
export class MessageRenderer {
  constructor(
    private readonly ctx: Context,
    private readonly domain: string,
  ) {}

  isQQ(session?: Session): boolean {
    return session?.platform === "qq";
  }

  /**
   * 发送（或返回）回复内容。
   * @returns QQ 平台发送成功时返回 undefined；其它情况返回可直接发给用户的纯文本
   */
  async send(
    session: Session | undefined,
    content: string,
    keyboard?: Keyboard,
  ): Promise<string | undefined> {
    if (!this.isQQ(session)) return content;

    try {
      const qq = session as unknown as QQSession;
      const payload: Record<string, unknown> = {
        msg_id: qq.messageId,
        msg_type: 2,
        markdown: { content },
      };
      if (keyboard) payload.keyboard = keyboard;
      await qq.bot.internal.sendMessage(qq.channelId, payload);
      return undefined;
    } catch (error) {
      this.ctx
        .logger("oni-sync-bot")
        .warn("QQ Markdown 发送失败，降级为纯文本:", error);
      return content;
    }
  }

  async usageMessage(session?: Session): Promise<string | undefined> {
    if (this.isQQ(session)) {
      const markdown =
        "**以下是使用说明：**\n" +
        `> GG原站点: [https://${this.domain}/gg/88888888](https://${this.domain}/gg/88888888)\n` +
        `\n> bwiki: [https://${this.domain}/bw/88888888](https://${this.domain}/bw/88888888)\n`;
      return this.send(session, markdown);
    }
    return (
      `以下是使用说明：\nGG原站点: https://${this.domain}/gg/88888888\n` +
      `\nbwiki: https://${this.domain}/bw/88888888`
    );
  }

  async resultMessage(
    session: Session | undefined,
    page: RenderablePage,
    prefix?: string,
  ): Promise<string | undefined> {
    const hasMeta = Boolean(page.contributor || page.change_time);

    if (this.isQQ(session)) {
      let markdown = "";
      if (prefix) markdown += `**${prefix}**\n`;
      markdown += `**📖 ${page.title}**\n\n`;

      if (hasMeta) {
        markdown += QQ_STYLE_ROW_SEPARATOR;
        if (page.contributor) {
          markdown += `> **👤 最后贡献者：** ${page.contributor}\n`;
        }
        if (page.change_time) {
          markdown += `> **🕐 最后修改：** ${page.change_time}\n`;
        }
        markdown += `惟知是信  至诚若天\n${QQ_STYLE_ROW_SEPARATOR}`;
      }

      return this.send(session, markdown, this.pageKeyboard(page));
    }

    let message = "";
    if (prefix) message += `${prefix}\n`;
    message += `📖 ${page.title}\n`;

    if (hasMeta) {
      message += "--------\n";
      if (page.contributor) {
        message += `👤 最后贡献者：${page.contributor}\n`;
      }
      if (page.change_time) {
        message += `🕐 最后修改：${page.change_time}\n`;
      }
    }
    message += "惟知是信  至诚若天\n";
    message += "--------\n";
    message += `🔗 GG原站点: \`https://${this.domain}/gg/${page.id}\`\n`;
    message += `📚 bwiki: \`https://${this.domain}/bw/${page.id}\``;
    return message;
  }

  /** 命中多个候选时的按钮键盘（每行 2 个，跳 bwiki 镜像） */
  matchListKeyboard(matches: MatchResult[]): Keyboard {
    const rows: Array<{ buttons: LinkButton[] }> = [];
    for (let i = 0; i < matches.length; i += 2) {
      const buttons = matches.slice(i, i + 2).map((item) => {
        const label =
          item.title.length > 10 ? item.title.slice(0, 10) : item.title;
        return this.linkButton(
          `${item.id}`,
          label,
          `https://${this.domain}/bw/${item.id}`,
        );
      });
      rows.push({ buttons });
    }
    return { content: { rows } };
  }

  /** 单个页面结果的按钮键盘：原站 / 镜像 / 直链 */
  pageKeyboard(page: RenderablePage): Keyboard {
    return {
      content: {
        rows: [
          {
            buttons: [
              this.linkButton(
                `gg-${page.id}`,
                "GG 原站",
                `https://${this.domain}/gg/${page.id}`,
              ),
            ],
          },
          {
            buttons: [
              this.linkButton(
                `bw-${page.id}`,
                "Bwiki 镜像",
                `https://${this.domain}/bw/${page.id}`,
              ),
            ],
          },
          {
            buttons: [
              this.linkButton(
                `wiki-${page.id}`,
                "GG直链",
                `https://oxygennotincluded.wiki.gg/zh/${encodeURIComponent(page.title)}`,
              ),
            ],
          },
        ],
      },
    };
  }

  private linkButton(idSuffix: string, label: string, url: string): LinkButton {
    return {
      id: `btn-${idSuffix}`,
      render_data: {
        label,
        visited_label: "已打开",
        style: 1,
      },
      action: {
        type: 0,
        permission: {
          type: 2,
        },
        data: url,
      },
    };
  }
}
