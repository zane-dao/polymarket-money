import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/app/App.js";
import { PREVIEW_WORKBENCH_DATA } from "../src/workbench/data/preview-data.js";
import { LineChart } from "../src/workbench/components/LineChart.js";

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("workbench application", () => {
  it("shows a recoverable connection failure without substituting demo data", async () => {
    render(
      <App
        dataSource={{
          loadAppStatus: async () => {
            throw new Error("本地只读接口暂不可用");
          },
          loadManifest: async () => {
            throw new Error("本地只读接口暂不可用");
          },
          loadViewData: async () => {
            throw new Error("本地只读接口暂不可用");
          },
        }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "本地后端暂时不可用" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/本地只读接口暂不可用/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新连接本地后端" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("DEMO DATA · 非真实数据"),
    ).not.toBeInTheDocument();
  });

  it("keeps the original static React view available inside developer diagnostics", async () => {
    const user = userEvent.setup();
    render(
      <App
        initialData={{
          sourceKind: "verified-local",
          decisions: [],
          runs: [],
          chartSeries: {
            raw: [],
            calibrated: [],
            bid: [],
            ask: [],
            pnl: [],
            brier: [],
          },
        }}
      />,
    );
    expect(screen.getByText("DEMO DATA · 非真实数据")).toBeInTheDocument();
    await user.click(screen.getByText("开发者视图"));
    await user.selectOptions(screen.getByLabelText("页面数据视图"), "verified");
    expect(
      screen.queryByText("DEMO DATA · 非真实数据"),
    ).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("页面数据视图"), "demo");
    expect(screen.getByText("DEMO DATA · 非真实数据")).toBeInTheDocument();
  });

  it("renders and navigates across every independent page module", async () => {
    const user = userEvent.setup();
    render(<App initialData={PREVIEW_WORKBENCH_DATA} />);
    expect(
      screen.getByRole("heading", {
        name: "从行情观察，到策略验证，再到逐事件复盘",
      }),
    ).toBeInTheDocument();
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
    for (const [button, heading] of pages) {
      await user.click(
        within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
          "link",
          { name: button },
        ),
      );
      expect(
        screen.getByRole("heading", { name: new RegExp(heading) }),
      ).toBeInTheDocument();
    }
    expect(screen.getByText("LIVE_TRADING_ENABLED=false")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "研究工作流" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("当前研究会话")).toBeInTheDocument();
  }, 10_000);

  it("opens and closes the paper-only ticket without exposing a live action", async () => {
    const user = userEvent.setup();
    render(<App initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(
      screen
        .getByRole("navigation", { name: "主导航" })
        .querySelectorAll("a")[1]!,
    );
    await user.click(screen.getByRole("button", { name: "模拟票据" }));
    expect(
      screen.getByRole("dialog", { name: "模拟订单票据" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /真实|live/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭模拟票据" }));
    expect(
      screen.queryByRole("dialog", { name: "模拟订单票据" }),
    ).not.toBeInTheDocument();
  });

  it("opens help as a keyboard-dismissible dialog and restores focus", async () => {
    const user = userEvent.setup();
    render(<App initialData={PREVIEW_WORKBENCH_DATA} />);
    const trigger = screen.getByRole("button", { name: "打开工作台帮助" });
    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "研究工作台说明" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "关闭工作台帮助" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "研究工作台说明" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("analysis chart", () => {
  it("renders a flat no-trade curve, real time labels and keyboard readout", async () => {
    const user = userEvent.setup();
    render(
      <LineChart
        unit=" USDC"
        series={[
          {
            label: "现金基线",
            color: "#4fd17d",
            points: [
              { x: "2026-07-21T00:00:00Z", value: 1000 },
              { x: "2026-07-22T00:00:00Z", value: 1000 },
            ],
          },
        ]}
      />,
    );
    const chart = screen.getByLabelText(/使用左右方向键读取数据/);
    expect(screen.getByText("现金基线")).toBeInTheDocument();
    await user.click(chart);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("status")).toHaveTextContent("1.0k USDC");
  });

  it("keeps negative values and distinct line styles in the SVG", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            label: "收益",
            color: "#4fd17d",
            points: [
              { x: 0, value: 0 },
              { x: 1, value: 8 },
            ],
          },
          {
            label: "回撤",
            color: "#ff676f",
            lineStyle: "dashed",
            points: [
              { x: 0, value: 0 },
              { x: 1, value: -4 },
            ],
          },
        ]}
      />,
    );
    expect(
      container.querySelector('polyline[stroke="#ff676f"]'),
    ).toHaveAttribute("stroke-dasharray", "6 4");
    expect(container.querySelector(".chart__zero")).toBeInTheDocument();
  });
});
