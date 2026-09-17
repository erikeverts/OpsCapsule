import type {
  PaneKind,
  RuntimePaths,
  WorkspaceDefinition,
} from "../../shared/contracts.js";

export interface RuntimeLaunchContext {
  workspace: WorkspaceDefinition;
  runtime: RuntimePaths;
  environment: Record<string, string>;
  role: PaneKind;
}

export interface ProcessLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface RuntimeAdapter {
  readonly id: string;
  buildLaunchSpec(context: RuntimeLaunchContext): ProcessLaunchSpec;
}

