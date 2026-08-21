#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const recordPath = process.env.WAVES_TEST_RECORD;
const serializedResults = process.env.WAVES_TEST_RESULTS;
if (recordPath === undefined || serializedResults === undefined) {
  process.stderr.write("missing fake CLI configuration");
  process.exit(2);
}

const previousCalls = existsSync(recordPath)
  ? readFileSync(recordPath, "utf8").split("\n").filter(Boolean).length
  : 0;
const results = JSON.parse(serializedResults);
const result = results[previousCalls];
appendFileSync(recordPath, `${JSON.stringify(process.argv.slice(2))}\n`);
if (result === undefined) {
  process.stderr.write("unexpected fake CLI call");
  process.exit(2);
}

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.exitCode ?? 0);
