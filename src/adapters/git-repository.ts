import { isAbsolute } from "node:path";

import { z } from "zod";

import { AdapterError } from "../planning/adapter-error.js";
import type {
  DiscoveredRepository,
  RepositoryPort,
} from "../planning/contracts.js";
import {
  runProcess,
  type ProcessLogger,
  type ProcessRunner,
  type RunProcessOptions,
} from "./run-process.js";

const COMPONENT = /^[A-Za-z0-9_.-]+$/u;
const OWNER = /^[A-Za-z0-9-]+$/u;
const nonEmptyOutputSchema = z.string().trim().min(1);

export interface RepositoryPortOptions {
  readonly runner?: ProcessRunner;
  readonly gitExecutable?: string;
  readonly signal?: AbortSignal;
  readonly logger?: ProcessLogger;
}

export function createRepositoryPort(
  options: RepositoryPortOptions = {},
): RepositoryPort {
  const runner = options.runner ?? runProcess;
  const executable = options.gitExecutable ?? "git";

  return {
    async discover(cwd: string): Promise<DiscoveredRepository> {
      const inside = await runGit(
        runner,
        executable,
        ["rev-parse", "--is-inside-work-tree"],
        cwd,
        options,
      );
      if (inside.trim() !== "true") {
        throw unsupported("trusted project is not a Git worktree");
      }

      const worktreeRoot = parseAbsolutePath(
        await runGit(
          runner,
          executable,
          ["rev-parse", "--show-toplevel"],
          cwd,
          options,
        ),
      );
      const commonDir = parseAbsolutePath(
        await runGit(
          runner,
          executable,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          cwd,
          options,
        ),
      );
      const originOutput = await runGit(
        runner,
        executable,
        ["remote", "get-url", "--all", "origin"],
        cwd,
        options,
      );
      const originUrls = originOutput
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (originUrls.length !== 1) {
        throw unsupported("repository must have exactly one origin fetch URL");
      }
      const originUrl = originUrls[0];
      if (originUrl === undefined) {
        throw unsupported("repository origin is missing");
      }
      const identity = parseGitHubOrigin(originUrl);

      return {
        worktreeRoot,
        commonDir,
        originUrl,
        owner: identity.owner,
        name: identity.name,
      };
    },
  };
}

export function parseGitHubOrigin(originUrl: string): {
  readonly owner: string;
  readonly name: string;
} {
  if (/[\u0000-\u001f\u007f]/u.test(originUrl)) {
    throw unsupported("repository origin URL is unsupported");
  }

  const scp = /^git@github\.com:([^/]+)\/([^/]+)\.git$/iu.exec(originUrl);
  if (scp !== null) {
    return validateIdentity(scp[1], scp[2]);
  }

  let url: URL;
  try {
    url = new URL(originUrl);
  } catch {
    throw unsupported("repository origin URL is unsupported");
  }
  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw unsupported("repository origin URL is unsupported");
  }
  if (url.protocol === "https:") {
    if (url.username !== "" || url.password !== "") {
      throw unsupported("repository origin URL is unsupported");
    }
  } else if (url.protocol === "ssh:") {
    if (url.username !== "git" || url.password !== "") {
      throw unsupported("repository origin URL is unsupported");
    }
  } else {
    throw unsupported("repository origin URL is unsupported");
  }

  const pathMatch = /^\/([^/]+)\/([^/]+)\.git$/u.exec(url.pathname);
  if (pathMatch === null) {
    throw unsupported("repository origin URL is unsupported");
  }
  return validateIdentity(pathMatch[1], pathMatch[2]);
}

async function runGit(
  runner: ProcessRunner,
  executable: string,
  args: readonly string[],
  cwd: string,
  options: RepositoryPortOptions,
): Promise<string> {
  const processOptions: RunProcessOptions = {
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
  const result = await runner(executable, args, processOptions);
  if (result.exitCode !== 0) {
    throw unsupported("trusted project is not a Git worktree");
  }
  return result.stdout;
}

function parseAbsolutePath(output: string): string {
  const parsed = nonEmptyOutputSchema.safeParse(output);
  if (!parsed.success || !isAbsolute(parsed.data)) {
    throw new AdapterError("invalid_response", "Git returned an invalid path");
  }
  return parsed.data;
}

function validateIdentity(
  owner: string | undefined,
  name: string | undefined,
): { readonly owner: string; readonly name: string } {
  if (
    owner === undefined ||
    name === undefined ||
    !OWNER.test(owner) ||
    !COMPONENT.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw unsupported("repository origin URL is unsupported");
  }
  return { owner, name };
}

function unsupported(message: string): AdapterError {
  return new AdapterError("unsupported_repository", message);
}
