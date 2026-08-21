import type { FatalCode } from "./contracts.js";

export type AdapterErrorCode = FatalCode | "not_found" | "gone" | "cancelled";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: AdapterErrorCode,
    message: string,
    retryAfterSeconds: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdapterError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
