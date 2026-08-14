import { describe, expect, test, vi } from "vitest";

import { AdapterError } from "../../src/planning/adapter-error.js";
import { runProcess } from "../../src/adapters/run-process.js";

describe("runProcess", () => {
  test("should pass argv without a shell and keep output streams separate", async () => {
    const dangerousArgument = "$(printf injected)";

    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1]); process.stderr.write('warning')",
      dangerousArgument,
    ]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: dangerousArgument,
      stderr: "warning",
    });
  });

  test("should stop a process when stdout exceeds its byte cap", async () => {
    const result = runProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1024))"],
      { stdoutLimitBytes: 32 },
    );

    await expect(result).rejects.toMatchObject({
      name: "AdapterError",
      code: "resource_limit",
      message: "process stdout limit exceeded",
    });
  });

  test("should terminate a process when its timeout expires", async () => {
    const result = runProcess(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { timeoutMs: 20 },
    );

    await expect(result).rejects.toEqual(
      expect.objectContaining<Partial<AdapterError>>({
        code: "timeout",
        message: "process timed out",
      }),
    );
  });

  test("should not spawn when cancellation was already requested", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runProcess(process.execPath, ["-e", "process.exit(0)"], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  test("should log only sanitized process metadata", async () => {
    const debug = vi.fn();

    await runProcess(process.execPath, ["-e", "process.exit(0)", "secret"], {
      logger: { debug },
    });

    expect(debug).toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain("secret");
  });
});
