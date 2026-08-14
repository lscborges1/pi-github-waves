import { spawn } from "node:child_process";

import { AdapterError } from "../planning/adapter-error.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;

export interface ProcessLogger {
  debug(
    event: string,
    context: Readonly<Record<string, string | number | boolean>>,
  ): void;
}

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
  readonly logger?: ProcessLogger;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<ProcessResult>;

export function runProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  if (options.signal?.aborted === true) {
    return Promise.reject(new AdapterError("cancelled", "process cancelled"));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdoutLimit =
    options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES;
  const stderrLimit =
    options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES;
  const startedAt = Date.now();
  options.logger?.debug("process_started", {
    executable,
    argumentCount: args.length,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingError: AdapterError | null = null;

    const stopWith = (error: AdapterError): void => {
      if (pendingError !== null) return;
      pendingError = error;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      stopWith(new AdapterError("timeout", "process timed out"));
    }, timeoutMs);
    const abort = (): void => {
      stopWith(new AdapterError("cancelled", "process cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutLimit) {
        stopWith(
          new AdapterError(
            "resource_limit",
            "process stdout limit exceeded",
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > stderrLimit) {
        stopWith(
          new AdapterError(
            "resource_limit",
            "process stderr limit exceeded",
          ),
        );
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on("error", (cause: Error) => {
      stopWith(
        new AdapterError("process_failed", "process could not be started", null, {
          cause,
        }),
      );
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      options.logger?.debug("process_finished", {
        executable,
        argumentCount: args.length,
        durationMs: Date.now() - startedAt,
        exitCode: exitCode ?? -1,
        stdoutBytes,
        stderrBytes,
      });
      if (pendingError !== null) {
        reject(pendingError);
        return;
      }
      if (exitCode === null) {
        reject(
          new AdapterError(
            "process_failed",
            "process terminated without an exit code",
          ),
        );
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}
