import type {
  CloudConnectionSummary,
} from "../../shared/contracts.js";
import type { CloudConnection } from "../../shared/workspace-schema.js";

export interface CloudProviderAdapter {
  readonly provider: string;
  summarize(connection: CloudConnection): CloudConnectionSummary;
  environment(connection: CloudConnection): Record<string, string>;
}

