import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type PropsWithChildren } from "react";

import { INITIAL_WORKBENCH_STATE, reduceWorkbenchState, type WorkbenchAction, type WorkbenchState } from "../domain/workbench.js";
import { INITIAL_RESEARCH_SESSION, researchSessionFromUrl, stageForRoute, workbenchRouteFromUrl, workbenchSearch } from "../domain/research-session.js";

const WorkbenchContext = createContext<Readonly<{ state: WorkbenchState; dispatch: Dispatch<WorkbenchAction> }> | null>(null);

export function WorkbenchProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(reduceWorkbenchState, INITIAL_WORKBENCH_STATE, (initial) => {
    if (typeof window === "undefined") return initial;
    const activeRoute = workbenchRouteFromUrl(window.location.search);
    const restoredSession = {
      ...INITIAL_RESEARCH_SESSION,
      ...researchSessionFromUrl(window.location.search),
    };
    return {
      ...initial,
      activeRoute,
      researchSession: {
        ...restoredSession,
        stage: stageForRoute(activeRoute, restoredSession.stage),
      },
    };
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = workbenchSearch(state.researchSession, state.activeRoute);
    if (window.location.search !== next) window.history.replaceState(null, "", `${window.location.pathname}${next}${window.location.hash}`);
  }, [state.activeRoute, state.researchSession]);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (value === null) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return value;
}
