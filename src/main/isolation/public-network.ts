import { isIP } from "node:net";
import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";
import { isLoopbackName } from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { createResolvedAddressGuard } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";

const publicAddressGuard = createResolvedAddressGuard();

export function allowsPublicDestination({
  host,
  port,
}: NetworkHostPattern): boolean {
  const canonicalHost = canonicalizeHost(host);
  if (!canonicalHost || isLoopbackName(canonicalHost)) {
    return false;
  }

  if (isIP(canonicalHost)) {
    // The runtime regards an explicitly allowed IP literal as intentional and
    // normally skips its resolved-address checks. Public mode is broader than
    // an explicit allow rule, so re-run those checks against literal targets.
    return publicAddressGuard.permits(
      "opscapsule-public-destination.invalid",
      canonicalHost,
      port ?? 0,
    );
  }

  // Sandbox Runtime resolves hostnames through this same guard before dialing.
  return true;
}
