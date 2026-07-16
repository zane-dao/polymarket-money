# Batch 3B Verdict

结论分类：`WEAK_RESEARCH_SIGNAL`。

工程门通过：公开数据固定 revision/hash，官方标签覆盖 100%，Binance 覆盖 100%，无身份冲突、
无切分重叠、无未来数据；三种时间可见性、四种执行情景、Decimal PnL、逐 fill 费用和冻结配置
均有代码与离线测试。

研究门未达到候选 edge：B3/30 仅在 BASE_1S 小幅为正，+1 tick 压力转负，bootstrap 下界小于
0，去掉最好三天后为负，UTC/波动率分层也显示集中。B2 明显差于市场，B1 没有可交易净 EV。

是否值得进入 shadow：否。当前结果只支持“可能有很弱、需要更多独立数据才能判断的信号”，
不支持长期 shadow，更不支持实盘。若继续，先做长期只读采集，获得可证明连续性、四时钟、
更完整 ask-side 数据和 point-in-time 费率；任何 GARCH/漂移/VaR/CVaR 研究必须另开预注册批次。

