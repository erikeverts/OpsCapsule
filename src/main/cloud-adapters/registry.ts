import type { CloudConnectionSummary } from "../../shared/contracts.js";
import type { CloudConnection } from "../../shared/workspace-schema.js";
import { AwsCloudProviderAdapter } from "./aws.js";
import type { CloudProviderAdapter } from "./types.js";

export class CloudAdapterRegistry {
  private readonly adapters = new Map<string, CloudProviderAdapter>();

  constructor(adapters: CloudProviderAdapter[] = [new AwsCloudProviderAdapter()]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.provider, adapter);
    }
  }

  summarize(connection: CloudConnection): CloudConnectionSummary {
    const adapter = this.adapters.get(connection.provider);
    if (!adapter) {
      return {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
      };
    }
    return adapter.summarize(connection);
  }

  environment(connection: CloudConnection): Record<string, string> {
    const adapter = this.adapters.get(connection.provider);
    if (!adapter) {
      throw new Error(
        `Cloud provider '${connection.provider}' is configured but not supported yet`,
      );
    }
    return adapter.environment(connection);
  }
}

