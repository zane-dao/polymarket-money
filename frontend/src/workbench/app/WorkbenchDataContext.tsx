import { createContext, useContext, type PropsWithChildren } from "react";

import type { WorkbenchViewData } from "../domain/read-model.js";

export type WorkbenchDataValue = WorkbenchViewData & Readonly<{ refresh(): Promise<void>; loadError: string | null }>;
const WorkbenchDataContext = createContext<WorkbenchDataValue | null>(null);

export function WorkbenchDataProvider({ data, refresh, loadError = null, children }: PropsWithChildren<{ data: WorkbenchViewData; refresh?: () => Promise<void>; loadError?: string | null }>) {
  return <WorkbenchDataContext.Provider value={{ ...data, refresh: refresh ?? (async () => undefined), loadError }}>{children}</WorkbenchDataContext.Provider>;
}

export function useWorkbenchData(): WorkbenchDataValue {
  const data = useContext(WorkbenchDataContext);
  if (data === null) throw new Error("useWorkbenchData must be used inside WorkbenchDataProvider");
  return data;
}
