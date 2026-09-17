import { z } from "zod";
import type { CloudConnectionSummary } from "../../shared/contracts.js";
import type { CloudConnection } from "../../shared/workspace-schema.js";
import type { CloudProviderAdapter } from "./types.js";

const awsConfigurationSchema = z.object({
  authentication: z.object({
    type: z.literal("profile"),
    profile: z.string().min(1),
  }),
  expectedIdentity: z.object({
    accountId: z.string().regex(/^\d{12}$/),
  }),
  defaults: z.object({
    region: z.string().min(1),
  }),
});

export class AwsCloudProviderAdapter implements CloudProviderAdapter {
  readonly provider = "aws";

  summarize(connection: CloudConnection): CloudConnectionSummary {
    const config = awsConfigurationSchema.parse(connection.config);
    return {
      id: connection.id,
      name: connection.name,
      provider: this.provider,
      identity: config.expectedIdentity.accountId,
      location: config.defaults.region,
    };
  }

  environment(connection: CloudConnection): Record<string, string> {
    const config = awsConfigurationSchema.parse(connection.config);
    return {
      AWS_PROFILE: config.authentication.profile,
      AWS_REGION: config.defaults.region,
      AWS_DEFAULT_REGION: config.defaults.region,
      OPSCAPSULE_CLOUD_PROVIDER: this.provider,
      OPSCAPSULE_CLOUD_IDENTITY: config.expectedIdentity.accountId,
    };
  }
}

