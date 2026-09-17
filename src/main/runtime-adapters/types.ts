import type {
  PaneKind,
  RuntimePaths,
} from "../../shared/contracts.js";

export interface RuntimeLaunchContext {
  runtime: RuntimePaths;
  environment: Record<string, string>;
  role: PaneKind;
  cwd: string;
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
