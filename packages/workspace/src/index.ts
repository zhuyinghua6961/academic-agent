import type {WorkspacePort} from "@academic-agent/workspace-port";

import type {ProjectWorkspace} from "./workspace.js";

export {ProjectWorkspace} from "./workspace.js";
export type {WorkspacePort} from "@academic-agent/workspace-port";

export type ProjectWorkspaceSatisfiesWorkspacePort = ProjectWorkspace extends WorkspacePort
  ? true
  : never;
