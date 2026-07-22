export const APP_STATUS_SCHEMA_V1 = "app-status-v1" as const;

export type AvailableModuleStatus = Readonly<{
  moduleId: string;
  availability: "available";
}>;

export type UnavailableModuleStatus = Readonly<{
  moduleId: string;
  availability: "unavailable";
  reason: string;
}>;

export type ModuleStatus = AvailableModuleStatus | UnavailableModuleStatus;

export type AppStatusV1 = Readonly<{
  schemaVersion: typeof APP_STATUS_SCHEMA_V1;
  generatedAtUtc: string;
  appVersion: string;
  mode: "paper-only";
  liveTradingEnabled: false;
  dataRootConfigured: boolean;
  modules: readonly ModuleStatus[];
}>;

const APP_STATUS_KEYS = [
  "schemaVersion",
  "generatedAtUtc",
  "appVersion",
  "mode",
  "liveTradingEnabled",
  "dataRootConfigured",
  "modules",
] as const;

const AVAILABLE_MODULE_KEYS = ["moduleId", "availability"] as const;
const UNAVAILABLE_MODULE_KEYS = ["moduleId", "availability", "reason"] as const;
const UTC_SECONDS =
  /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

export class AppStatusContractError extends Error {
  override readonly name = "AppStatusContractError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new AppStatusContractError(`${path} has unexpected or missing fields`);
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppStatusContractError(`${path} must be a non-empty string`);
  }
  return value;
}

function parseModuleStatus(value: unknown, index: number): ModuleStatus {
  const path = `modules[${index}]`;
  if (!isRecord(value)) {
    throw new AppStatusContractError(`${path} must be an object`);
  }
  const moduleId = requireNonEmptyString(value.moduleId, `${path}.moduleId`);
  if (value.availability === "available") {
    requireExactKeys(value, AVAILABLE_MODULE_KEYS, path);
    return { moduleId, availability: "available" };
  }
  if (value.availability === "unavailable") {
    requireExactKeys(value, UNAVAILABLE_MODULE_KEYS, path);
    return {
      moduleId,
      availability: "unavailable",
      reason: requireNonEmptyString(value.reason, `${path}.reason`),
    };
  }
  throw new AppStatusContractError(`${path}.availability is invalid`);
}

export function parseAppStatusV1(value: unknown): AppStatusV1 {
  if (!isRecord(value)) {
    throw new AppStatusContractError("app status must be an object");
  }
  requireExactKeys(value, APP_STATUS_KEYS, "app status");
  if (value.schemaVersion !== APP_STATUS_SCHEMA_V1) {
    throw new AppStatusContractError("unsupported app status schema");
  }
  if (value.mode !== "paper-only" || value.liveTradingEnabled !== false) {
    throw new AppStatusContractError("desktop status must remain paper-only");
  }
  if (typeof value.dataRootConfigured !== "boolean") {
    throw new AppStatusContractError("dataRootConfigured must be boolean");
  }
  const generatedAtUtc = requireNonEmptyString(value.generatedAtUtc, "generatedAtUtc");
  if (!UTC_SECONDS.test(generatedAtUtc) || Number.isNaN(Date.parse(generatedAtUtc))) {
    throw new AppStatusContractError("generatedAtUtc must be a valid UTC timestamp");
  }
  const appVersion = requireNonEmptyString(value.appVersion, "appVersion");
  if (!Array.isArray(value.modules)) {
    throw new AppStatusContractError("modules must be an array");
  }
  const modules = value.modules.map(parseModuleStatus);
  const moduleIds = new Set(modules.map((module) => module.moduleId));
  if (moduleIds.size !== modules.length) {
    throw new AppStatusContractError("module ids must be unique");
  }
  return {
    schemaVersion: APP_STATUS_SCHEMA_V1,
    generatedAtUtc,
    appVersion,
    mode: "paper-only",
    liveTradingEnabled: false,
    dataRootConfigured: value.dataRootConfigured,
    modules,
  };
}
