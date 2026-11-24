import type { Mwn } from "mwn";

/** MediaWiki 登录态失效（`assert=user` 失败）时返回的错误码 */
function isAssertUserFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "assertuserfailed"
  );
}

export interface ReloginAwareProxyOptions {
  /** 取当前 bot；未就绪时抛错 */
  getBot: () => Mwn;
  /** 登录态失效时调用，用于重新登录 */
  relogin: () => Promise<void>;
  /** 出错信息里使用的站点名 */
  label: string;
}

/** 登录相关的内部方法，必须绑定到 bot 本身 */
const METHODS_TO_SKIP = new Set(["cookieJar", "setRequestOptions"]);

function memberOf(bot: Mwn, prop: string | symbol): unknown {
  return (bot as unknown as Record<string | symbol, unknown>)[prop];
}

/**
 * 生成「登录态永远有效」的 mwn 代理：assert=user 失败时自动重登并重放。
 *
 * 用 Proxy 是因为要完整转发任意成员（含 `continuedQueryGen` 生成器与 `options`）。
 * ⚠️ 转发必须保留 `this`（一律 `fn.apply(bot, args)`），裸调会崩在 `this.request`。
 */
export function createReloginAwareProxy(
  options: ReloginAwareProxyOptions,
): Mwn {
  const { getBot, relogin, label } = options;

  const invokeWithRelogin = async <T>(
    invoke: (bot: Mwn) => Promise<T>,
  ): Promise<T> => {
    try {
      return await invoke(getBot());
    } catch (error) {
      if (!isAssertUserFailed(error)) throw error;
      await relogin();
      return await invoke(getBot());
    }
  };

  return new Proxy({} as Mwn, {
    get: (_target, prop) => {
      const value = memberOf(getBot(), prop);

      // 非函数成员（如 options）直接透传
      if (typeof value !== "function") return value;

      if (typeof prop === "string" && METHODS_TO_SKIP.has(prop)) {
        return value.bind(getBot());
      }

      // 异步生成器：重试必须发生在**迭代过程中**，而不是创建生成器的那一刻
      if (prop === "continuedQueryGen") {
        return (...args: unknown[]) => {
          const createIterator = (callArgs: unknown[]) => {
            const bot = getBot();
            const generate = memberOf(bot, "continuedQueryGen") as (
              ...a: unknown[]
            ) => AsyncGenerator<unknown>;
            // 必须 apply 到 bot：裸调用会丢 this，mwn 内部随即崩在 this.request
            return generate.apply(bot, callArgs)[Symbol.asyncIterator]();
          };

          let iterator = createIterator(args);

          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next(): Promise<IteratorResult<unknown>> {
              try {
                return await iterator.next();
              } catch (error) {
                if (!isAssertUserFailed(error)) throw error;
                await relogin();
                iterator = createIterator(args);
                return await iterator.next();
              }
            },
          };
        };
      }

      return (...args: unknown[]) =>
        invokeWithRelogin((bot) => {
          const method = memberOf(bot, prop);
          if (typeof method !== "function") {
            throw new Error(`${label} bot 缺少方法 ${String(prop)}`);
          }
          const call = method as (...a: unknown[]) => Promise<unknown>;
          return call.apply(bot, args);
        });
    },
  });
}
