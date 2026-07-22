import { parseAppStatusV1, type AppStatusV1 } from "../types/app-status.js";

export interface AppStatusTransport {
  invoke(command: "get_app_status_v1"): Promise<unknown>;
}

export async function loadAppStatus(
  transport: AppStatusTransport,
): Promise<AppStatusV1> {
  return parseAppStatusV1(await transport.invoke("get_app_status_v1"));
}
