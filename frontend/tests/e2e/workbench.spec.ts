import { expect, test } from "@playwright/test";

const pages = [
  ["总览", "从行情观察，到策略验证，再到逐事件复盘"],
  ["实时驾驶舱", "实时驾驶舱"],
  ["决策记录", "决策记录"],
  ["策略工作室", "策略工作室"],
  ["数据集管理", "数据集管理"],
  ["回测实验室", "回测实验室"],
  ["市场回放", "市场回放"],
  ["策略竞技场", "策略竞技场"],
  ["系统健康", "系统健康"],
] as const;

test("all workbench routes render without browser errors", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByText("PAPER ONLY · LIVE OFF")).toBeVisible();
  for (const [navigationLabel, heading] of pages) {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: new RegExp(navigationLabel) }).click();
    await expect(page.getByRole("heading", { name: new RegExp(heading) })).toBeVisible();
  }
  expect(browserErrors).toEqual([]);

  if (testInfo.project.name === "desktop-chromium") {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /总览/ }).click();
    await page.screenshot({ path: "/tmp/polymarket-money-playwright/desktop-overview.png", fullPage: true });
  } else {
    await page.screenshot({ path: "/tmp/polymarket-money-playwright/mobile-health.png", fullPage: true });
  }
});

test("production live page fails closed without a public market session", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /实时驾驶舱/ }).click();
  await expect(page.getByText("实时快照不可用")).toBeVisible();
  await expect(page.getByText(/公共行情采集尚未获批准|公共行情主机离线/)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "模拟订单票据" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /真实|live/i })).toHaveCount(0);
});
