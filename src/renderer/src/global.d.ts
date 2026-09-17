import type { OpsCapsuleApi } from "../../shared/contracts";

declare global {
  interface Window {
    opsCapsule: OpsCapsuleApi;
  }
}

export {};

