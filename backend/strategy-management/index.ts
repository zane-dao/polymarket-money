import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const STRATEGY_VERSION_SCHEMA_V1 = "strategy-version-v1" as const;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const PARAMETER_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u;

export type StrategyParameterValue = string | number | boolean;
export type StrategyParameterRule = Readonly<{
  type: "string" | "number" | "boolean";
  required: boolean;
  minimum?: number;
  maximum?: number;
}>;

export type StrategyDefinitionV1 = Readonly<{
  strategyId: string;
  displayName: string;
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

export class StrategyCatalog {
  readonly #definitions = new Map<string, StrategyDefinitionV1>();

  register(definition: StrategyDefinitionV1): void {
    validateId(definition.strategyId, "strategyId");
    if (definition.displayName.trim() === "") throw new Error("displayName must be non-empty");
    if (definition.allowedModes.length === 0 || new Set(definition.allowedModes).size !== definition.allowedModes.length
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
      if (typeof value === "number" && ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) {
        throw new Error(`parameter ${name} is outside its allowed range`);
      }
    }
  }
}

export function createDefaultStrategyCatalog(): StrategyCatalog {
  const catalog = new StrategyCatalog();
  const common = Object.freeze({
    edgeThreshold: { type: "number" as const, required: true, minimum: 0, maximum: 0.25 },
    maxEdge: { type: "number" as const, required: true, minimum: 0.000001, maximum: 1 },
    maxStakeUsdc: { type: "number" as const, required: true, minimum: 1, maximum: 100_000 },
    bookParticipation: { type: "number" as const, required: true, minimum: 0.000001, maximum: 1 },
  });
  for (const [strategyId, displayName] of [["J_FEE_AWARE", "J Fee Aware"], ["K_DUAL_VOL", "K Dual Volatility"]] as const) {
    catalog.register({ strategyId, displayName, runtime: "python", allowedModes: ["backtest", "paper"], parameters: common });
  }
  catalog.register({ strategyId: "L_ADAPTIVE_EXECUTION_V2", displayName: "L Adaptive Execution V2 (Research Only)", runtime: "python", allowedModes: ["backtest"], parameters: {
    maxSignalEdge: { type: "number", required: true, minimum: 0.000001, maximum: 1 },
    maxStakeUsdc: { type: "number", required: true, minimum: 1, maximum: 100_000 },
    bookParticipation: { type: "number", required: true, minimum: 0.000001, maximum: 1 },
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
}
