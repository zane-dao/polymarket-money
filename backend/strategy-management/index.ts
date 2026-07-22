import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const STRATEGY_VERSION_SCHEMA_V1 = "strategy-version-v1" as const;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const PARAMETER_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u;

export type StrategyParameterValue = string | number | boolean;
export type StrategyParameterRule = Readonly<{
  type: "string" | "number" | "boolean";
  required: boolean;
  defaultValue?: StrategyParameterValue;
  minimum?: number;
  maximum?: number;
  displayName?: string;
  description?: string;
  unit?: string;
}>;

export type StrategyDefinitionV1 = Readonly<{
  strategyId: string;
  displayName: string;
  summary?: string;
  family?: string;
  researchStatus?: "PAPER_READY" | "RESEARCH_ONLY" | "RESEARCH_GATE_FAILED";
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  runtime: "typescript" | "python";
  allowedModes: readonly ("backtest" | "paper")[];
  parameters: Readonly<Record<string, StrategyParameterRule>>;
}>;

export type StrategyVersionV1 = Readonly<{
  schemaVersion: typeof STRATEGY_VERSION_SCHEMA_V1;
  strategyId: string;
  version: string;
  description: string;
  parameters: Readonly<Record<string, StrategyParameterValue>>;
  createdAtUtc: string;
}>;

export type StrategyParameterWarningV1 = Readonly<{
  code: "NARROW_EDGE_WINDOW" | "EMPTY_EDGE_WINDOW" | "LOW_SIGNAL_EDGE_GUARD" | "ZERO_SIGNAL_EDGE_GUARD";
  severity: "warning" | "danger";
  message: string;
}>;

export class StrategyCatalog {
  readonly #definitions = new Map<string, StrategyDefinitionV1>();

  register(definition: StrategyDefinitionV1): void {
    validateId(definition.strategyId, "strategyId");
    if (definition.displayName.trim() === "") throw new Error("displayName must be non-empty");
    if ((definition.allowedModes.length === 0 && definition.researchStatus !== "RESEARCH_GATE_FAILED")
      || new Set(definition.allowedModes).size !== definition.allowedModes.length
      || definition.allowedModes.some((mode) => mode !== "backtest" && mode !== "paper")) throw new Error("allowedModes is invalid");
    if (this.#definitions.has(definition.strategyId)) throw new Error(`strategy already registered: ${definition.strategyId}`);
    for (const [name, rule] of Object.entries(definition.parameters)) {
      if (!PARAMETER_NAME.test(name)) throw new Error(`parameter ${name} is invalid`);
      if ((rule.minimum !== undefined || rule.maximum !== undefined) && rule.type !== "number") {
        throw new Error(`parameter ${name} has numeric bounds but is not a number`);
      }
      if (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum) {
        throw new Error(`parameter ${name} has an inverted range`);
      }
      if (rule.defaultValue !== undefined) validateParameterValue(name, rule, rule.defaultValue);
    }
    this.#definitions.set(definition.strategyId, Object.freeze(definition));
  }

  list(): readonly StrategyDefinitionV1[] {
    return Object.freeze([...this.#definitions.values()].sort((a, b) => a.strategyId.localeCompare(b.strategyId)));
  }

  get(strategyId: string): StrategyDefinitionV1 {
    const value = this.#definitions.get(strategyId);
    if (value === undefined) throw new Error(`unknown strategy: ${strategyId}`);
    return value;
  }

  validateParameters(strategyId: string, parameters: Readonly<Record<string, StrategyParameterValue>>): void {
    const definition = this.get(strategyId);
    for (const key of Object.keys(parameters)) {
      if (definition.parameters[key] === undefined) throw new Error(`unknown parameter: ${key}`);
    }
    for (const [name, rule] of Object.entries(definition.parameters)) {
      const value = parameters[name];
      if (value === undefined) {
        if (rule.required) throw new Error(`missing parameter: ${name}`);
        continue;
      }
      if (typeof value !== rule.type || (typeof value === "number" && !Number.isFinite(value))) {
        throw new Error(`parameter ${name} must be ${rule.type}`);
      }
      validateParameterValue(name, rule, value);
    }
  }

  parameterWarnings(strategyId: string, parameters: Readonly<Record<string, StrategyParameterValue>>): readonly StrategyParameterWarningV1[] {
    this.validateParameters(strategyId, parameters);
    const warnings: StrategyParameterWarningV1[] = [];
    if ((strategyId === "J_FEE_AWARE" || strategyId === "K_DUAL_VOL") &&
      typeof parameters.edgeThreshold === "number" && typeof parameters.maxEdge === "number") {
      const usable = parameters.maxEdge - parameters.edgeThreshold;
      if (usable <= 0) warnings.push({ code: "EMPTY_EDGE_WINDOW", severity: "danger", message: "最大信号优势不高于最小净优势；该版本会保持观望，不会形成可交易优势区间。" });
      else if (usable < 0.01) warnings.push({ code: "NARROW_EDGE_WINDOW", severity: "warning", message: "最大信号优势与最小净优势之间不足 0.01；可交易优势区间很窄，可能几乎不产生信号。" });
    }
    if ((strategyId === "L_ADAPTIVE_EXECUTION_V1" || strategyId === "L_ADAPTIVE_EXECUTION_V2") && typeof parameters.maxSignalEdge === "number") {
      if (parameters.maxSignalEdge === 0) warnings.push({ code: "ZERO_SIGNAL_EDGE_GUARD", severity: "danger", message: "最大信号优势为 0；所有正优势信号都会被 L 的异常值保护拒绝。" });
      else if (parameters.maxSignalEdge < 0.05) warnings.push({ code: "LOW_SIGNAL_EDGE_GUARD", severity: "warning", message: "最大信号优势低于 0.05；L 可能把大量信号判为异常并保持观望。" });
    }
    return Object.freeze(warnings);
  }
}

function validateParameterValue(name: string, rule: StrategyParameterRule, value: StrategyParameterValue): void {
  if (typeof value !== rule.type || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`parameter ${name} must be ${rule.type}`);
  if (typeof value === "number" && ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) throw new Error(`parameter ${name} is outside its allowed range`);
}

export function createDefaultStrategyCatalog(): StrategyCatalog {
  const catalog = new StrategyCatalog();
  const common = Object.freeze({
    edgeThreshold: { type: "number" as const, required: true, defaultValue: 0.05, minimum: 0, maximum: 0.25, displayName: "最小净优势", description: "扣除费用后允许提出交易的最低优势。", unit: "概率" },
    maxEdge: { type: "number" as const, required: true, defaultValue: 0.25, minimum: 0, maximum: 1, displayName: "最大信号优势", description: "超过该值的信号按异常值处理；接近最小净优势时会给出告警，不阻止研究。", unit: "概率" },
    maxStakeUsdc: { type: "number" as const, required: true, defaultValue: 400, minimum: 1, maximum: 100_000, displayName: "单次最大投入", description: "单次模拟决策允许使用的最大名义金额。", unit: "USDC" },
    bookParticipation: { type: "number" as const, required: true, defaultValue: 0.5, minimum: 0.000001, maximum: 1, displayName: "盘口参与比例", description: "模拟成交量相对可见盘口深度的上限。", unit: "比例" },
  });
  for (const [strategyId, displayName, summary, family] of [
    ["J_FEE_AWARE", "费用感知概率策略（J）", "在可成交价格、费用与盘口深度约束下评估 BTC 5 分钟概率优势。", "费用感知概率"],
    ["K_DUAL_VOL", "双波动率概率策略（K）", "利用快慢波动率估计 BTC 5 分钟方向概率，并以可执行成本过滤。", "双尺度波动率"],
  ] as const) {
    catalog.register({ strategyId, displayName, summary, family, researchStatus: "PAPER_READY", riskLevel: "MEDIUM", runtime: "python", allowedModes: ["backtest", "paper"], parameters: common });
  }
  catalog.register({ strategyId: "L_ADAPTIVE_EXECUTION_V1", displayName: "自适应执行（L V1 · 历史门失败）", summary: "保留用于审计 L 的首版研究；历史证据门失败，不能保存新版本、回测或 Paper。", family: "自适应执行", researchStatus: "RESEARCH_GATE_FAILED", riskLevel: "HIGH", runtime: "python", allowedModes: [], parameters: {
    maxSignalEdge: { type: "number", required: true, defaultValue: 0.25, minimum: 0, maximum: 1, displayName: "最大信号优势", description: "历史 L V1 的异常信号上限；低值会告警但不改写审计配置。", unit: "概率" },
    maxStakeUsdc: { type: "number", required: true, defaultValue: 400, minimum: 1, maximum: 100_000, displayName: "单次最大投入", description: "历史 L V1 的名义金额上限；不可作为新的研究调参入口。", unit: "USDC" },
    bookParticipation: { type: "number", required: true, defaultValue: 0.5, minimum: 0.000001, maximum: 1, displayName: "盘口参与比例", description: "历史 L V1 的可见深度参与上限；不可作为新的研究调参入口。", unit: "比例" },
  }});
  catalog.register({ strategyId: "L_ADAPTIVE_EXECUTION_V2", displayName: "自适应执行（L V2 · 研究候选）", summary: "基于冻结训练选择的自适应执行候选；只允许验证集离线回测。", family: "自适应执行", researchStatus: "RESEARCH_ONLY", riskLevel: "HIGH", runtime: "python", allowedModes: ["backtest"], parameters: {
    maxSignalEdge: { type: "number", required: true, defaultValue: 0.25, minimum: 0, maximum: 1, displayName: "最大信号优势", description: "限制进入执行模型的信号优势；低值会告警但不阻止研究版本保存。", unit: "概率" },
    maxStakeUsdc: { type: "number", required: true, defaultValue: 400, minimum: 1, maximum: 100_000, displayName: "单次最大投入", description: "单次模拟决策允许使用的最大名义金额。", unit: "USDC" },
    bookParticipation: { type: "number", required: true, defaultValue: 0.5, minimum: 0.000001, maximum: 1, displayName: "盘口参与比例", description: "模拟成交量相对可见盘口深度的上限。", unit: "比例" },
  }});
  return catalog;
}

function validateId(value: string, path: string): void {
  if (!ID.test(value)) throw new Error(`${path} is invalid`);
}

function validateVersion(value: StrategyVersionV1): void {
  if (value.schemaVersion !== STRATEGY_VERSION_SCHEMA_V1) throw new Error("unsupported strategy version schema");
  validateId(value.strategyId, "strategyId");
  if (!VERSION.test(value.version)) throw new Error("version must use semantic version syntax");
  if (value.description.trim() === "") throw new Error("description must be non-empty");
  if (!value.createdAtUtc.endsWith("Z") || Number.isNaN(Date.parse(value.createdAtUtc))) throw new Error("createdAtUtc must be UTC");
}

/** Backend-only immutable JSON store. The renderer receives DTOs through commands and never sees this path. */
export class FileStrategyVersionStore {
  readonly #root: string;

  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new Error("dataRoot must be absolute");
    this.#root = resolve(dataRoot, "workbench", "strategy-versions");
  }

  async save(catalog: StrategyCatalog, value: StrategyVersionV1): Promise<void> {
    validateVersion(value);
    catalog.validateParameters(value.strategyId, value.parameters);
    const directory = join(this.#root, value.strategyId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${value.version}.json`);
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  async load(catalog: StrategyCatalog, strategyId: string, version: string): Promise<StrategyVersionV1> {
    validateId(strategyId, "strategyId");
    if (!VERSION.test(version)) throw new Error("version must use semantic version syntax");
    const raw: unknown = JSON.parse(await readFile(join(this.#root, strategyId, `${version}.json`), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("strategy version must be an object");
    const value = raw as StrategyVersionV1;
    const keys = ["schemaVersion", "strategyId", "version", "description", "parameters", "createdAtUtc"].sort();
    if (Object.keys(raw).sort().join("\0") !== keys.join("\0") || typeof value.parameters !== "object" || value.parameters === null || Array.isArray(value.parameters)) {
      throw new Error("strategy version has an unsupported shape");
    }
    validateVersion(value);
    catalog.validateParameters(strategyId, value.parameters);
    return Object.freeze(value);
  }

  async list(strategyId: string): Promise<readonly string[]> {
    validateId(strategyId, "strategyId");
    try {
      const entries = await readdir(join(this.#root, strategyId), { withFileTypes: true });
      return Object.freeze(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -5)).filter((version) => VERSION.test(version)).sort());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
  }

  async delete(catalog: StrategyCatalog, strategyId: string, version: string, confirmation: string): Promise<void> {
    if (confirmation !== `${strategyId}:${version}`) throw new Error("strategy version deletion confirmation does not match");
    await this.load(catalog, strategyId, version);
    await unlink(join(this.#root, strategyId, `${version}.json`));
  }
}
