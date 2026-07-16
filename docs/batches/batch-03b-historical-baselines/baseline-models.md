# Batch 3B Baseline 模型

## B0 NO_TRADE

始终不交易，不产生概率指标，交易净值恒为 0；它是资本保全基准。

## B1 MARKET_PROBABILITY

`p_up` 为决策时可见 Up 最佳 bid/ask midpoint。midpoint 只用于概率校准；买 Up/Down 均以
后续执行情景的 ask 成交。费用后没有任何预注册阈值下的正 EV 交易，因此 Final Test 交易数为 0。

## B2 GBM_BINANCE_PROXY

Binance BTCUSDT 仅为 Chainlink proxy。drift 固定为 0；波动率窗口只从预注册的 30/60/120
秒中由 Validation 选择，三个决策 horizon 最终均选 120 秒。输入只使用市场开始价、决策前
当前价、决策前收益和剩余时间，不使用结束后价格。

## B3 MARKET_PRIOR_LOGISTIC

使用 `logit(p_model)=logit(p_market)+beta*x`。特征仅含 Binance 相对开始价 log return、过去
30/60/120 秒 realized volatility、remaining seconds、Up/Down spread、最佳 ask size、简单
top-of-book imbalance 和 midpoint。Train-only scaler；固定 350 次迭代、学习率 0.08、L2 0.01。

Final Test 前冻结的阈值：B1 三个 horizon 均 0.02；B2 为 60s=0.01、30s=0.01、15s=0.02；
B3 为 60s=0.01、30s=0.00、15s=0.00。

本批没有 GARCH、VaR/CVaR、树模型、神经网络或自动特征搜索。B2 的显著劣化说明零漂移 GBM
proxy 不适合作为当前可部署信号，但不能据此否定未来在独立批次研究漂移/GARCH 的价值。

