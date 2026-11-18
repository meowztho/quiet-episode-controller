#!/usr/bin/env node
// Cross-platform Python launcher for this project's own scripts.
//
// On Windows the `python` command is frequently the Microsoft Store execution
// alias: it prints "Python wurde nicht gefunden" and exits with code 49 instead
// of running anything. package.json therefore never invokes `python` directly.
// Every Python step goes through this launcher, which resolves a working
// CPython 3 once, forwards argv unchanged, and forwards the exit code.
//
// Resolution order: QEC_PYTHON override, `py -3`, `python3`, `python`. Each
// candidate is probed with a trivial `-c` command, so a stub or a Python 2
// installation is skipped instead of silently breaking the run.
//
// Usage: node scripts/run_python.mjs <script.py> [args...]

import { spawnSync } from "node:child_process";

const PROBE = "import sys; sys.stdout.write(str(sys.version_info[0]))";
const CANDIDATES = [
  ...(process.env.QEC_PYTHON ? [[process.env.QEC_PYTHON]] : []),
  ["py", "-3"],
  ["python3"],
  ["python"],
];

function probe(command) {
  const result = spawnSync(command[0], [...command.slice(1), "-c", PROBE], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  return (result.stdout || "").trim() === "3";
}

function resolveInterpreter() {
  const tried = [];
  for (const candidate of CANDIDATES) {
    tried.push(candidate.join(" "));
    if (probe(candidate)) return { command: candidate, tried };
  }
  return { command: null, tried };
}

const { command, tried } = resolveInterpreter();

if (!command) {
  console.error("[qec] No working Python 3 interpreter found.");
  console.error(`[qec] Tried: ${tried.join(", ")}`);
  console.error("[qec] Set QEC_PYTHON to a Python 3 executable, for example:");
  console.error("[qec]   POSIX: QEC_PYTHON=/usr/bin/python3 npm run check");
  console.error("[qec]   cmd:   set QEC_PYTHON=C:\\Python312\\python.exe && npm run check");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("[qec] Usage: node scripts/run_python.mjs <script.py> [args...]");
  process.exit(2);
}

const result = spawnSync(command[0], [...command.slice(1), ...args], {
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`[qec] Failed to start ${command.join(" ")}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
