import type {
  CredentialKind,
  CredentialReference,
} from "../../../shared/credentials.js";
import { AwsCredentialDelivery } from "./aws.js";
import { ProviderOAuthDelivery } from "./provider-oauth.js";
import type {
  CredentialAssignment,
  CredentialDeliveryAdapter,
  DeliveryContext,
} from "./types.js";

export class CredentialDeliveryRegistry {
  private readonly adapters: CredentialDeliveryAdapter[];

  constructor(adapters?: CredentialDeliveryAdapter[]) {
    this.adapters = adapters ?? [
      new AwsCredentialDelivery(),
      new ProviderOAuthDelivery(),
    ];
  }

  adapterFor(kind: CredentialKind): CredentialDeliveryAdapter {
    const id = kind === "provider-oauth" ? "provider-oauth" : "aws";
    const adapter = this.adapters.find((candidate) => candidate.id === id);
    if (!adapter) {
      throw new Error(`No credential delivery adapter for kind '${kind}'.`);
    }
    return adapter;
  }

  /**
   * True when at least one assigned credential is delivered by pulling. Only
   * then does the capsule need a broker socket, so a capsule using nothing but
   * materialized provider logins opens no channel at all.
   */
  requiresBrokerChannel(
    references: ReadonlyArray<CredentialReference | undefined>,
  ): boolean {
    return references.some(
      (reference) =>
        reference !== undefined &&
        this.adapterFor(reference.kind).transport === "pull",
    );
  }

  private group(
    assignments: readonly CredentialAssignment[],
  ): Map<CredentialDeliveryAdapter, CredentialAssignment[]> {
    const grouped = new Map<CredentialDeliveryAdapter, CredentialAssignment[]>();
    for (const assignment of assignments) {
      const adapter = this.adapterFor(assignment.reference.kind);
      const existing = grouped.get(adapter);
      if (existing) {
        existing.push(assignment);
      } else {
        grouped.set(adapter, [assignment]);
      }
    }
    return grouped;
  }

  async prepare(context: DeliveryContext): Promise<void> {
    for (const [adapter, assignments] of this.group(context.assignments)) {
      await adapter.prepare({ ...context, assignments });
    }
  }

  async teardown(context: DeliveryContext): Promise<void> {
    for (const [adapter, assignments] of this.group(context.assignments)) {
      await adapter.teardown?.({ ...context, assignments });
    }
  }

  formatResponse(reference: CredentialReference, secret: string): string {
    const adapter = this.adapterFor(reference.kind);
    if (!adapter.formatResponse) {
      throw new Error(
        `Credential reference '${reference.id}' is delivered by ${adapter.id} and is not served over the broker channel.`,
      );
    }
    return adapter.formatResponse(secret);
  }
}
