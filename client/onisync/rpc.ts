import { send } from "@koishijs/client";

/**
 * 调用控制台事件。
 *
 * 失败只打 warn 不抛出：控制台偶发断线时页面应该继续可用，
 * 而不是把整块 UI 变成未捕获异常。
 */
export async function call<T>(
  event: string,
  payload?: unknown,
): Promise<T | undefined> {
  try {
    return (await (send as any)(event, payload)) as T;
  } catch (error) {
    console.warn(`${event} 调用失败`, error);
    return undefined;
  }
}
