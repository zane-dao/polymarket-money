import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../src/app/App.js";
import { PREVIEW_WORKBENCH_DATA } from "../src/workbench/data/preview-data.js";

describe("workbench application", () => {
  it("keeps the static interface visible and locked when verified data loading fails", async () => {
    render(<App dataSource={{
      loadAppStatus: async () => { throw new Error("本地只读接口暂不可用"); },
      loadManifest: async () => { throw new Error("本地只读接口暂不可用"); },
      loadViewData: async () => { throw new Error("本地只读接口暂不可用"); },
    }} />);
    expect(await screen.findByText("真实数据接入失败，正在展示界面演示")).toBeInTheDocument();
    expect(screen.getByText(/本地只读接口暂不可用/)).toBeInTheDocument();
    expect(screen.getByText("DEMO DATA · 非真实数据")).toBeInTheDocument();
    expect(screen.getByText(/\+214\.80 USDC/)).toBeInTheDocument();
    expect(document.querySelector(".demo-surface")).toHaveAttribute("inert");
  });

  it("keeps the original static React view available inside developer diagnostics", async () => {
    const user = userEvent.setup();
    render(<App initialData={{ sourceKind: "verified-local", decisions: [], runs: [], chartSeries: { raw: [], calibrated: [], bid: [], ask: [], pnl: [], brier: [] } }} />);
    expect(screen.getByText("DEMO DATA · 非真实数据")).toBeInTheDocument();
    await user.click(screen.getByText("开发者视图"));
    await user.selectOptions(screen.getByLabelText("页面数据视图"), "verified");
    expect(screen.queryByText("DEMO DATA · 非真实数据")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("页面数据视图"), "demo");
    expect(screen.getByText("DEMO DATA · 非真实数据")).toBeInTheDocument();
  });

  it("renders and navigates across every independent page module", async () => {
    const user = userEvent.setup();
    render(<App initialData={PREVIEW_WORKBENCH_DATA} />);
    expect(screen.getByRole("heading", { name: "从行情观察，到策略验证，再到逐事件复盘" })).toBeInTheDocument();
    const pages = [
      ["实时驾驶舱", "实时驾驶舱"],
      ["决策记录", "决策记录"],
      ["策略工作室", "策略工作室"],
      ["数据集管理", "数据集管理"],
      ["回测实验室", "回测实验室"],
      ["市场回放", "市场回放"],
      ["策略竞技场", "策略竞技场"],
      ["系统健康", "系统健康"],
    ] as const;
    const routeNames = ["实时驾驶舱", "决策记录", "策略工作室", "数据集管理", "回测实验室", "市场回放", "策略竞技场", "系统健康"];
    for (const [button, heading] of pages) {
      await user.click(screen.getByRole("navigation", { name: "主导航" }).querySelectorAll("button")[routeNames.indexOf(button) + 1]!);
      expect(screen.getByRole("heading", { name: new RegExp(heading) })).toBeInTheDocument();
    }
    expect(screen.getByText("LIVE_TRADING_ENABLED=false")).toBeInTheDocument();
  });

  it("opens and closes the paper-only ticket without exposing a live action", async () => {
    const user = userEvent.setup();
    render(<App initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("navigation", { name: "主导航" }).querySelectorAll("button")[1]!);
    await user.click(screen.getByRole("button", { name: "模拟票据" }));
    expect(screen.getByRole("dialog", { name: "模拟订单票据" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /真实|live/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭模拟票据" }));
    expect(screen.queryByRole("dialog", { name: "模拟订单票据" })).not.toBeInTheDocument();
  });
});
