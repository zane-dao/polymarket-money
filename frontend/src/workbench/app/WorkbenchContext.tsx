import { createContext, useContext, useMemo, useReducer, type Dispatch, type PropsWithChildren } from "react";

import { INITIAL_WORKBENCH_STATE, reduceWorkbenchState, type WorkbenchAction, type WorkbenchState } from "../domain/workbench.js";

const WorkbenchContext = createContext<Readonly<{ state: WorkbenchState; dispatch: Dispatch<WorkbenchAction> }> | null>(null);

export function WorkbenchProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(reduceWorkbenchState, INITIAL_WORKBENCH_STATE);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (value === null) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return value;
}
