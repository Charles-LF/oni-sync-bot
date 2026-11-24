import assert from "node:assert/strict";
import { SyncNotifier } from "../src/services/syncNotifier";

function createNotifier(channelIds: string[]) {
  const sent: Array<{ channelId: string; message: string }> = [];
  const ctx = {
    bots: [
      {
        platform: "qq",
        isActive: true,
        async sendMessage(channelId: string, message: string) {
          sent.push({ channelId, message });
          return [];
        },
      },
    ],
  } as any;

  const notifier = new SyncNotifier(ctx, channelIds);
  return { notifier, sent };
}

describe("services/syncNotifier 群通知", () => {
  it("没有配置群号时视为关闭，不注册回调", () => {
    const { notifier } = createNotifier([]);
    assert.equal(notifier.enabled, false);
  });

  it("页面条目带编辑者与摘要", async () => {
    const { notifier, sent } = createNotifier(["group:123"]);
    await notifier.notify([
      {
        title: "电解器",
        type: "page",
        user: "YVVT",
        timestamp: "2024-05-01T10:00:00Z",
        comment: "改耗电",
      },
    ]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, "123", "group: 前缀应被去掉");
    assert.ok(sent[0].message.includes("📖 1. 电解器｜YVVT｜"), sent[0].message);
    assert.ok(sent[0].message.includes("改耗电"), sent[0].message);
  });

  it("图片条目只标时间，不出现「未知」编辑者", async () => {
    const { notifier, sent } = createNotifier(["123"]);
    await notifier.notify([
      { title: "Icon Building.png", type: "image", timestamp: "2024-05-01T10:00:00Z" },
    ]);

    assert.equal(sent.length, 1);
    assert.ok(sent[0].message.includes("🖼️ 1. Icon Building.png｜"), sent[0].message);
    assert.ok(!sent[0].message.includes("未知"), sent[0].message);
  });
});
