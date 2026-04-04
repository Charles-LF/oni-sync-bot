import { Context, Logger, Schema, Session } from "koishi";
import { resolve } from "path";

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
    "onitodos/delete"(data: { id: number }): Promise<{ success: boolean }>;
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
  public static readonly inject = ["database", "console"];
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
  }

  private getCreatedBy(session?: Session) {
    return session?.userId || "默认创建人";
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("todolist", "缺氧 TodoList", { authority: 1 })
      .alias("todo")
      .action(async ({ session }) => {
        await session.execute("todo.list");
      });

    ctx
      .command("todo.list", "查看 TodoList", { authority: 1 })
      .alias("todo.l")
      .action(async ({ session }) => {
        return "📋 请访问 https://klei.vip/onitodos 进行 TodoList 管理";
      });

    ctx
      .command("todo.add <title>", "添加待办事项", { authority: 1 })
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
      .command("todo.edit <id>", "编辑待办事项", { authority: 1 })
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
      .command("todo.complete <id>", "标记待办事项为完成", { authority: 1 })
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
      .command("todo.uncomplete <id>", "标记待办事项为未完成", { authority: 1 })
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
  }

  private registerConsoleEvents(ctx: Context) {
    ctx.console.addListener(
      "onitodos/list",
      async () => {
        const todos = await ctx.database.get("onitodos", {});
        return todos;
      },
      { authority: 1 },
    );

    ctx.console.addListener(
      "onitodos/add",
      async (data) => {
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
      },
      { authority: 1 },
    );

    ctx.console.addListener(
      "onitodos/update",
      async (data) => {
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
      },
      { authority: 1 },
    );

    ctx.console.addListener(
      "onitodos/delete",
      async (data) => {
        await ctx.database.remove("onitodos", { id: data.id });
        this.log.info(`控制台删除待办事项成功: ID ${data.id}`);
        return { success: true };
      },
      { authority: 1 },
    );
  }
}

export function apply(ctx: Context) {
  ctx.plugin(TodoList);
}
