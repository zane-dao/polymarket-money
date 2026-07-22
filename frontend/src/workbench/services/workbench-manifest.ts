import {
  WORKBENCH_ROUTE_IDS,
  type DataAvailability,
  type WorkbenchCapability,
  type WorkbenchManifestV1,
  type WorkbenchRouteId,
} from "../domain/workbench.js";

const MANIFEST_KEYS = ["schemaVersion", "generatedAtUtc", "capabilities"] as const;
const CAPABILITY_KEYS = ["routeId", "label", "shortLabel", "availability"] as const;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export class WorkbenchManifestError extends Error {
  override readonly name = "WorkbenchManifestError";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WorkbenchManifestError(`${path} has unexpected or missing fields`);
  }
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkbenchManifestError(`${path} must be a non-empty string`);
  }
  return value;
}

function utc(value: unknown, path: string): string {
  const timestamp = nonEmpty(value, path);
  if (!UTC_TIMESTAMP.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new WorkbenchManifestError(`${path} must be a valid UTC timestamp`);
  }
  return timestamp;
}

function availability(value: unknown, path: string): DataAvailability {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new WorkbenchManifestError(`${path} is invalid`);
  }
  if (value.status === "loading") {
    exactKeys(value, ["status"], path);
    return { status: "loading" };
  }
  if (value.status === "ready") {
    exactKeys(value, ["status", "asOfUtc"], path);
    return { status: "ready", asOfUtc: utc(value.asOfUtc, `${path}.asOfUtc`) };
  }
  if (value.status === "unavailable") {
    exactKeys(value, ["status", "reason"], path);
    return { status: "unavailable", reason: nonEmpty(value.reason, `${path}.reason`) };
  }
  throw new WorkbenchManifestError(`${path}.status is unsupported`);
}

function capability(value: unknown, index: number): WorkbenchCapability {
  const path = `capabilities[${index}]`;
  if (!isRecord(value)) {
    throw new WorkbenchManifestError(`${path} must be an object`);
  }
  exactKeys(value, CAPABILITY_KEYS, path);
  if (!WORKBENCH_ROUTE_IDS.includes(value.routeId as WorkbenchRouteId)) {
    throw new WorkbenchManifestError(`${path}.routeId is unsupported`);
  }
  return {
    routeId: value.routeId as WorkbenchRouteId,
    label: nonEmpty(value.label, `${path}.label`),
    shortLabel: nonEmpty(value.shortLabel, `${path}.shortLabel`),
    availability: availability(value.availability, `${path}.availability`),
  };
}

export function parseWorkbenchManifestV1(value: unknown): WorkbenchManifestV1 {
  if (!isRecord(value)) {
    throw new WorkbenchManifestError("manifest must be an object");
  }
  exactKeys(value, MANIFEST_KEYS, "manifest");
  if (value.schemaVersion !== "workbench-manifest-v1") {
    throw new WorkbenchManifestError("unsupported manifest schema");
  }
  if (!Array.isArray(value.capabilities)) {
    throw new WorkbenchManifestError("capabilities must be an array");
  }
  const capabilities = value.capabilities.map(capability);
  const routeIds = new Set(capabilities.map((item) => item.routeId));
  if (routeIds.size !== capabilities.length) {
    throw new WorkbenchManifestError("capability route ids must be unique");
  }
  if (WORKBENCH_ROUTE_IDS.some((routeId) => !routeIds.has(routeId))) {
    throw new WorkbenchManifestError("manifest must declare every workbench route");
  }
  return {
    schemaVersion: "workbench-manifest-v1",
    generatedAtUtc: utc(value.generatedAtUtc, "generatedAtUtc"),
    capabilities,
  };
}
