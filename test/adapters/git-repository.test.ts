import { describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  createRepositoryPort,
  parseGitHubOrigin,
} from "../../src/adapters/git-repository.js";
import type { ProcessRunner } from "../../src/adapters/run-process.js";

const argvSchema = z.array(z.string());

describe("parseGitHubOrigin", () => {
  test.each([
    "git@github.com:acme/waves.git",
    "git@GITHUB.COM:acme/waves.git",
    "ssh://git@github.com/acme/waves.git",
    "https://github.com/acme/waves.git",
  ])("should parse the supported origin %s", (originUrl) => {
    expect(parseGitHubOrigin(originUrl)).toEqual({
      owner: "acme",
      name: "waves",
    });
  });

  test.each([
    "GIT@github.com:acme/waves.git",
    "git://github.com/acme/waves.git",
    "git@github.com:acme/waves",
    "ssh://alice@github.com/acme/waves.git",
    "ssh://git@github.com:22/acme/waves.git",
    "https://token@github.com/acme/waves.git",
    "https://github.com/acme/waves.git?ref=main",
    "https://github.com/acme/group/waves.git",
    "https://gitlab.com/acme/waves.git",
  ])("should reject the unsupported origin %s", (originUrl) => {
    expect(() => parseGitHubOrigin(originUrl)).toThrow(
      expect.objectContaining({ code: "unsupported_repository" }),
    );
  });
});

describe("createRepositoryPort", () => {
  test("should discover a worktree using read-only git argv", async () => {
    const runner = sequenceRunner([
      { exitCode: 0, stdout: "true\n", stderr: "" },
      { exitCode: 0, stdout: "/repo/worktree\n", stderr: "" },
      { exitCode: 0, stdout: "/repo/.git\n", stderr: "" },
      {
        exitCode: 0,
        stdout: "git@github.com:acme/waves.git\n",
        stderr: "",
      },
    ]);
    const repository = createRepositoryPort({ runner });

    const result = await repository.discover("/repo/worktree/subdir");

    expect(result).toEqual({
      worktreeRoot: "/repo/worktree",
      commonDir: "/repo/.git",
      originUrl: "git@github.com:acme/waves.git",
      owner: "acme",
      name: "waves",
    });
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["remote", "get-url", "--all", "origin"],
    ]);
  });

  test("should reject repositories with multiple origin fetch URLs", async () => {
    const runner = sequenceRunner([
      { exitCode: 0, stdout: "true\n", stderr: "" },
      { exitCode: 0, stdout: "/repo\n", stderr: "" },
      { exitCode: 0, stdout: "/repo/.git\n", stderr: "" },
      {
        exitCode: 0,
        stdout:
          "git@github.com:acme/one.git\ngit@github.com:acme/two.git\n",
        stderr: "",
      },
    ]);

    await expect(
      createRepositoryPort({ runner }).discover("/repo"),
    ).rejects.toMatchObject({ code: "unsupported_repository" });
  });

  test("should reject a directory outside a git worktree", async () => {
    const runner = sequenceRunner([
      { exitCode: 128, stdout: "", stderr: "not a git repository" },
    ]);

    await expect(
      createRepositoryPort({ runner }).discover("/tmp"),
    ).rejects.toMatchObject({
      code: "unsupported_repository",
      message: "trusted project is not a Git worktree",
    });
  });

  test("should invoke a fake git executable without mutating commands", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "waves-git-"));
    const recordPath = join(temporaryDirectory, "calls.jsonl");
    const environment = {
      ...process.env,
      WAVES_TEST_RECORD: recordPath,
      WAVES_TEST_RESULTS: JSON.stringify([
        { stdout: "true\n" },
        { stdout: `${temporaryDirectory}\n` },
        { stdout: `${join(temporaryDirectory, ".git")}\n` },
        { stdout: "https://github.com/acme/waves.git\n" },
      ]),
    };

    try {
      const executable = fileURLToPath(
        new URL("../fixtures/bin/fake-cli.mjs", import.meta.url),
      );

      await createRepositoryPort({
        gitExecutable: executable,
        environment,
      }).discover(temporaryDirectory);

      const calls = (await readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => argvSchema.parse(JSON.parse(line) as unknown));
      expect(calls).toHaveLength(4);
      expect(calls.flat().join(" ")).not.toMatch(
        /\b(?:fetch|pull|push|commit|checkout|switch|reset|clean)\b/iu,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true });
    }
  });
});

function sequenceRunner(
  results: readonly Awaited<ReturnType<ProcessRunner>>[],
) {
  let index = 0;
  return vi.fn<ProcessRunner>(async () => {
    const result = results[index];
    index += 1;
    if (result === undefined) throw new Error("unexpected process call");
    return result;
  });
}
