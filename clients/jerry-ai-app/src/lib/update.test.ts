import { describe, expect, it } from "vitest";
import { compareVersions, isAndroidPlatform } from "./update";

describe("compareVersions", () => {
  it("主版本号更新时应判定为更新", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });

  it("补丁号比较应按数字而非字符串（10 > 9）", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
  });

  it("版本号相同应返回 0", () => {
    expect(compareVersions("0.1.2", "0.1.2")).toBe(0);
  });

  it("缺失段按 0 处理（0.1 等价于 0.1.0）", () => {
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.1", "0.1")).toBe(1);
  });

  it("旧版本应返回 -1", () => {
    expect(compareVersions("0.1.1", "0.1.2")).toBe(-1);
  });
});

describe("isAndroidPlatform", () => {
  it("桌面 UA 应返回 false", () => {
    // 模拟 Windows WebView2 UA
    const ua = navigator.userAgent;
    expect(typeof ua).toBe("string"); // 防御：jsdom 环境下 UA 存在
    // jsdom 默认 UA 不含 Android
    expect(isAndroidPlatform()).toBe(false);
  });
});
