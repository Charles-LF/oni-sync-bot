import { Context, Logger, Session } from "koishi";
import {} from "koishi-plugin-cron";

declare module "koishi" {
  interface Tables {
    onitodos: OniTodoItem;
  }
}

declare module "@koishijs/plugin-console" {
  interface Events {
    "onitodos/list"(): Promise<OniTodoItem[]>;
    "onitodos/add"(data: {
      title: string;
      content: string;
      createdBy?: string;
    }): Promise<OniTodoItem>;
    "onitodos/update"(data: {
      id: number;
      title?: string;
      content?: string;
      completed?: boolean;
      createdBy?: string;
    }): Promise<{ success: boolean }>;
  }
}

export interface OniTodoItem {
  id: number;
  title: string;
  content: string;
  completed: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export class TodoList {
  public static readonly inject = ["database", "console", "wikiBot", "cron"];
  public log: Logger;

  constructor(public ctx: Context) {
    this.log = ctx.logger("oni-todolist");

    ctx.model.extend(
      "onitodos",
      {
        id: "unsigned",
        title: "string",
        content: "text",
        completed: "boolean",
        createdBy: "string",
        createdAt: "timestamp",
        updatedAt: "timestamp",
      },
      {
        primary: "id",
        autoInc: true,
      },
    );

    this.registerCommands(ctx);
    this.registerConsoleEvents(ctx);
    this.registerCronJobs(ctx);
  }

  private registerCronJobs(ctx: Context) {
    ctx.cron("0 0 * * 1", async () => {
      if (!this.ctx.wikiBot.isReady) {
        this.log.warn("定时任务：WikiBot 服务未就绪，跳过同步模块");
        return;
      }
      this.log.info("定时任务：每周一同步 wiki.gg 模块到 TodoList");
      try {
        const { added, updated } = await this.syncModulesToTodos();
        this.log.info(`定时任务完成：新增 ${added} 个，更新 ${updated} 个`);
      } catch (err) {
        this.log.error("定时任务失败：同步模块", err);
      }
    });

    ctx.cron("0 0 * * 2", async () => {
      if (!this.ctx.wikiBot.isReady) {
        this.log.warn("定时任务：WikiBot 服务未就绪，跳过检查同步状态");
        return;
      }
      this.log.info("定时任务：每周二检查模块同步状态");
      try {
        const { checked, synced } = await this.checkSyncStatus();
        this.log.info(`定时任务完成：检查 ${checked} 个，已同步 ${synced} 个`);
      } catch (err) {
        this.log.error("定时任务失败：检查同步状态", err);
      }
    });
  }

  private async getAllModulesFromGG(): Promise<any[]> {
    const modules: any[] = [];
    let apcontinue: string | undefined;

    try {
      do {
        const params: any = {
          action: "query",
          format: "json",
          list: "allpages",
          indexpageids: 1,
          redirects: 1,
          formatversion: "2",
          apnamespace: "828",
          aplimit: "max",
        };

        if (apcontinue) {
          params.apcontinue = apcontinue;
          params.continue = "-||";
        }

        const res = await this.apiCallWithRetry(() =>
          this.ctx.wikiBot.ggbot.query(params),
        );

        if (res.query?.allpages) {
          modules.push(...res.query.allpages);
        }

        apcontinue = res.continue?.apcontinue;
      } while (apcontinue);

      this.log.info(`从 wiki.gg 获取到 ${modules.length} 个模块`);
      return modules;
    } catch (err) {
      this.log.error("从 wiki.gg 获取模块列表失败", err);
      throw err;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async apiCallWithRetry<T>(
    apiCall: () => Promise<T>,
    maxRetries = 3,
  ): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await apiCall();
      } catch (err) {
        if (i === maxRetries - 1) {
          throw err;
        }
        this.log.warn(`API 调用失败，正在重试 (${i + 1}/${maxRetries})...`);
        await this.sleep(2000);
      }
    }
    throw new Error("Max retries exceeded");
  }

  private async getModuleRevisionFromGG(title: string): Promise<any | null> {
    try {
      await this.sleep(1000);
      const res = await this.apiCallWithRetry(() =>
        this.ctx.wikiBot.ggbot.query({
          action: "query",
          format: "json",
          prop: "revisions",
          titles: title,
          formatversion: "2",
          rvprop: "timestamp|user|comment",
          rvlimit: "1",
        }),
      );

      if (res.query?.pages && res.query.pages.length > 0) {
        const page = res.query.pages[0];
        if (page.revisions && page.revisions.length > 0) {
          return {
            ...page,
            revision: page.revisions[0],
          };
        }
      }
      return null;
    } catch (err) {
      this.log.error(`从 wiki.gg 获取模块 ${title} 的修订信息失败`, err);
      return null;
    }
  }

  private async getModuleRevisionFromBWiki(title: string): Promise<any | null> {
    try {
      await this.sleep(1000);
      const res = await this.apiCallWithRetry(() =>
        this.ctx.wikiBot.bwikibot.query({
          action: "query",
          format: "json",
          prop: "revisions",
          titles: title,
          formatversion: "2",
          rvprop: "timestamp|user|comment",
          rvlimit: "1",
        }),
      );

      if (res.query?.pages && res.query.pages.length > 0) {
        const page = res.query.pages[0];
        if (page.revisions && page.revisions.length > 0) {
          return {
            ...page,
            revision: page.revisions[0],
          };
        }
      }
      return null;
    } catch (err) {
      this.log.error(`从 bwikia 获取模块 ${title} 的修订信息失败`, err);
      return null;
    }
  }

  private async syncModulesToTodos(): Promise<{
    added: number;
    updated: number;
  }> {
    if (!this.ctx.wikiBot.isReady) {
      this.log.warn("WikiBot 服务未就绪，无法同步模块");
      return { added: 0, updated: 0 };
    }
    const modules = await this.getAllModulesFromGG();
    const existingTodos = await this.ctx.database.get("onitodos", {});
    const existingTodoMap = new Map(existingTodos.map((t) => [t.title, t]));

    let added = 0;
    let updated = 0;

    for (const module of modules) {
      const moduleData = await this.getModuleRevisionFromGG(module.title);

      if (!moduleData || !moduleData.revision) {
        continue;
      }

      const revision = moduleData.revision;
      const createdAt = new Date(revision.timestamp);
      const updatedAt = new Date(revision.timestamp);

      if (existingTodoMap.has(module.title)) {
        const existingTodo = existingTodoMap.get(module.title)!;

        await this.ctx.database.set(
          "onitodos",
          { id: existingTodo.id },
          {
            content: revision.comment || "",
            createdBy: revision.user,
            createdAt,
            updatedAt,
          },
        );
        updated++;
      } else {
        await this.ctx.database.create("onitodos", {
          title: module.title,
          content: revision.comment || "",
          completed: false,
          createdBy: revision.user,
          createdAt,
          updatedAt,
        });
        added++;
      }
    }

    this.log.info(`同步模块到待办事项完成：新增 ${added}，更新 ${updated}`);
    return { added, updated };
  }

  private async checkSyncStatus(): Promise<{
    checked: number;
    synced: number;
  }> {
    if (!this.ctx.wikiBot.isReady) {
      this.log.warn("WikiBot 服务未就绪，无法检查同步状态");
      return { checked: 0, synced: 0 };
    }
    const todos = await this.ctx.database.get("onitodos", {});
    let checked = 0;
    let synced = 0;

    for (const todo of todos) {
      checked++;

      const ggRevision = await this.getModuleRevisionFromGG(todo.title);
      const bwikiRevision = await this.getModuleRevisionFromBWiki(todo.title);

      if (!ggRevision || !ggRevision.revision) {
        continue;
      }

      if (bwikiRevision && bwikiRevision.revision) {
        const ggTime = new Date(ggRevision.revision.timestamp).getTime();
        const bwikiTime = new Date(bwikiRevision.revision.timestamp).getTime();

        if (bwikiTime >= ggTime) {
          if (!todo.completed) {
            await this.ctx.database.set(
              "onitodos",
              { id: todo.id },
              { completed: true },
            );
          }
          synced++;
        } else {
          if (todo.completed) {
            await this.ctx.database.set(
              "onitodos",
              { id: todo.id },
              { completed: false },
            );
          }
        }
      }
    }

    this.log.info(`检查同步状态完成：检查 ${checked}，已同步 ${synced}`);
    return { checked, synced };
  }

  private getCreatedBy(session?: Session) {
    return session?.userId || "默认创建人";
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("todolist", "缺氧 TodoList")
      .alias("todo")
      .action(async ({ session }) => {
        await session.execute("todo.list");
      });

    ctx
      .command("todo.list", "查看 TodoList")
      .alias("todo.l")
      .action(async ({ session }) => {
        return "📋 请访问 https://klei.vip/onitodos 进行 TodoList 管理";
      });

    ctx
      .command("todo.add <title>", "添加待办事项")
      .alias("todo.a")
      .option("content", "-c <content>")
      .option("createdBy", "-u <createdBy>")
      .action(async ({ session, options }, title) => {
        if (!title) {
          return "❌ 请提供标题！用法：todo.add <标题> [-c <内容>] [-u <创建人>]";
        }
        try {
          const todo = await ctx.database.create("onitodos", {
            title,
            content: options.content || "",
            completed: false,
            createdBy: options.createdBy || this.getCreatedBy(session),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          this.log.info(`添加待办事项成功: ${title}`);
          return "✅ 已添加待办事项，请访问 https://klei.vip/onitodos 查看";
        } catch (err) {
          this.log.error("添加待办事项失败", err);
          return "❌ 添加待办事项失败，请查看日志";
        }
      });

    ctx
      .command("todo.edit <id>", "编辑待办事项")
      .alias("todo.e")
      .option("title", "-t <title>")
      .option("content", "-c <content>")
      .option("createdBy", "-u <createdBy>")
      .action(async ({ session, options }, idStr) => {
        const id = Number(idStr);
        if (!id || isNaN(id)) {
          return "❌ 请提供有效的 ID！";
        }
        try {
          const [todo] = await ctx.database.get("onitodos", { id });
          if (!todo) {
            return "❌ 未找到该 ID 的待办事项";
          }
          const updateData: Partial<OniTodoItem> = {
            updatedAt: new Date(),
          };
          if (options.title) updateData.title = options.title;
          if (options.content !== undefined)
            updateData.content = options.content;
          if (options.createdBy !== undefined)
            updateData.createdBy = options.createdBy;

          await ctx.database.set("onitodos", { id }, updateData);
          this.log.info(`编辑待办事项成功: ID ${id}`);
          return "✅ 已编辑待办事项，请访问 https://klei.vip/onitodos 查看";
        } catch (err) {
          this.log.error("编辑待办事项失败", err);
          return "❌ 编辑待办事项失败，请查看日志";
        }
      });

    ctx
      .command("todo.complete <id>", "标记待办事项为完成")
      .alias("todo.c")
      .action(async ({ session }, idStr) => {
        const id = Number(idStr);
        if (!id || isNaN(id)) {
          return "❌ 请提供有效的 ID！";
        }
        try {
          const [todo] = await ctx.database.get("onitodos", { id });
          if (!todo) {
            return "❌ 未找到该 ID 的待办事项";
          }
          await ctx.database.set(
            "onitodos",
            { id },
            { completed: true, updatedAt: new Date() },
          );
          this.log.info(`标记待办事项完成成功: ID ${id}`);
          return "✅ 已标记完成，请访问 https://klei.vip/onitodos 查看";
        } catch (err) {
          this.log.error("标记待办事项完成失败", err);
          return "❌ 标记待办事项完成失败，请查看日志";
        }
      });

    ctx
      .command("todo.uncomplete <id>", "标记待办事项为未完成")
      .alias("todo.u")
      .action(async ({ session }, idStr) => {
        const id = Number(idStr);
        if (!id || isNaN(id)) {
          return "❌ 请提供有效的 ID！";
        }
        try {
          const [todo] = await ctx.database.get("onitodos", { id });
          if (!todo) {
            return "❌ 未找到该 ID 的待办事项";
          }
          await ctx.database.set(
            "onitodos",
            { id },
            { completed: false, updatedAt: new Date() },
          );
          this.log.info(`标记待办事项未完成成功: ID ${id}`);
          return "✅ 已标记未完成，请访问 https://klei.vip/onitodos 查看";
        } catch (err) {
          this.log.error("标记待办事项未完成失败", err);
          return "❌ 标记待办事项未完成失败，请查看日志";
        }
      });

    ctx
      .command("todo.delete <id>", "删除待办事项", { authority: 2 })
      .alias("todo.d")
      .action(async ({ session }, idStr) => {
        const id = Number(idStr);
        if (!id || isNaN(id)) {
          return "❌ 请提供有效的 ID！";
        }
        try {
          const [todo] = await ctx.database.get("onitodos", { id });
          if (!todo) {
            return "❌ 未找到该 ID 的待办事项";
          }
          await ctx.database.remove("onitodos", { id });
          this.log.info(`删除待办事项成功: ID ${id}`);
          return "✅ 已删除待办事项，请访问 https://klei.vip/onitodos 查看";
        } catch (err) {
          this.log.error("删除待办事项失败", err);
          return "❌ 删除待办事项失败，请查看日志";
        }
      });

    ctx
      .command("todo.clear", "清空 TodoList", { authority: 2 })
      .action(async ({ session }) => {
        try {
          const result = await ctx.database.remove("onitodos", {});
          this.log.info(`清空 TodoList 成功，删除 ${result.removed} 条`);
          return "✅ 已清空 TodoList，请访问 https://klei.vip/onitodos 查看";
        } catch (err) {
          this.log.error("清空 TodoList 失败", err);
          return "❌ 清空 TodoList 失败，请查看日志";
        }
      });

    ctx
      .command("todo.syncmodules", "同步 wiki.gg 模块到 TodoList")
      .action(async ({ session }) => {
        if (!this.ctx.wikiBot.isReady) {
          return "❌ WikiBot 服务未就绪，请检查登录配置或查看日志";
        }
        try {
          const { added, updated } = await this.syncModulesToTodos();
          return `✅ 同步模块完成！新增 ${added} 个，更新 ${updated} 个，请访问 https://klei.vip/onitodos 查看`;
        } catch (err) {
          this.log.error("同步模块失败", err);
          return "❌ 同步模块失败，请查看日志";
        }
      });

    ctx
      .command("todo.checksync", "检查模块同步状态")
      .action(async ({ session }) => {
        if (!this.ctx.wikiBot.isReady) {
          return "❌ WikiBot 服务未就绪，请检查登录配置或查看日志";
        }
        try {
          const { checked, synced } = await this.checkSyncStatus();
          return `✅ 检查同步状态完成！检查 ${checked} 个，已同步 ${synced} 个，请访问 https://klei.vip/onitodos 查看`;
        } catch (err) {
          this.log.error("检查同步状态失败", err);
          return "❌ 检查同步状态失败，请查看日志";
        }
      });
  }

  private registerConsoleEvents(ctx: Context) {
    ctx.console.addListener("onitodos/list", async () => {
      const todos = await ctx.database.get("onitodos", {});
      return todos;
    });

    ctx.console.addListener("onitodos/add", async (data) => {
      const todo = await ctx.database.create("onitodos", {
        title: data.title,
        content: data.content || "",
        completed: false,
        createdBy: data.createdBy || "默认创建人",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      this.log.info(`控制台添加待办事项成功: ${data.title}`);
      return todo;
    });

    ctx.console.addListener("onitodos/update", async (data) => {
      const updateData: Partial<OniTodoItem> = {
        updatedAt: new Date(),
      };
      if (data.title !== undefined) updateData.title = data.title;
      if (data.content !== undefined) updateData.content = data.content;
      if (data.completed !== undefined) updateData.completed = data.completed;
      if (data.createdBy !== undefined) updateData.createdBy = data.createdBy;

      await ctx.database.set("onitodos", { id: data.id }, updateData);
      this.log.info(`控制台更新待办事项成功: ID ${data.id}`);
      return { success: true };
    });
  }
}

export function apply(ctx: Context) {
  ctx.plugin(TodoList);
}
