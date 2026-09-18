import type {
  CloudConnectionSummary,
} from "../../shared/contracts.js";
import type { CloudConnection } from "../../shared/workspace-schema.js";

export interface CloudEnvironmentContext {
  targetState: string;
}

export interface CloudProviderAdapter {
  readonly provider: string;
  summarize(connection: CloudConnection): CloudConnectionSummary;
  environment(
    connection: CloudConnection,
    context: CloudEnvironmentContext,
  ): Record<string, string>;
}
