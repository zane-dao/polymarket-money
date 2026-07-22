import { createContext, useContext, type PropsWithChildren } from "react";
import type { WorkbenchCommands } from "../services/workbench-commands.js";

const Context = createContext<WorkbenchCommands | null>(null);
export function WorkbenchCommandProvider({ commands, children }: PropsWithChildren<{ commands: WorkbenchCommands | null }>) { return <Context.Provider value={commands}>{children}</Context.Provider>; }
export function useWorkbenchCommands(): WorkbenchCommands | null { return useContext(Context); }
