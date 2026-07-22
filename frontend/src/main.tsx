import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.js";
import { browserWebTransport, createWorkbenchDataSource } from "./workbench/services/tauri-workbench-data-source.js";
import { createWorkbenchCommands } from "./workbench/services/workbench-commands.js";
import "./styles/index.css";
import "./styles/fidelity.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root mount point");
}

const transport = browserWebTransport();
createRoot(root).render(
  <StrictMode>
    <App dataSource={createWorkbenchDataSource(transport)} commands={createWorkbenchCommands(transport)} />
  </StrictMode>,
);
