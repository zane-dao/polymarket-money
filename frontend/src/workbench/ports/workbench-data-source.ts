import type { AppStatusV1 } from "../../types/app-status.js";
import type { WorkbenchViewData } from "../domain/read-model.js";
import type { WorkbenchManifestV1 } from "../domain/workbench.js";

/**
 * UI-facing read model boundary. Implementations may use a Tauri command,
 * verified local artifacts, or an in-memory test fixture. Components never
 * read files, invoke shell commands, or contact market providers directly.
 */
export interface WorkbenchDataSource {
  loadAppStatus(signal?: AbortSignal): Promise<AppStatusV1>;
  loadManifest(signal?: AbortSignal): Promise<WorkbenchManifestV1>;
  loadViewData(signal?: AbortSignal): Promise<WorkbenchViewData>;
}
