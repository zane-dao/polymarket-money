import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, statfs, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildKJPaperCohortReport,
  kjPaperCohortReportHash,
} from "../execution/src/product/kj-paper-cohort-report.js";

function inputs(): string[] {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--input") {
      const value = process.argv[index + 1];
      if (value === undefined) throw new Error("--input requires an absolute report directory");
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function regularDirectory(path: string, field: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new Error(`${field} must be a real non-symlink directory`);
  }
  return resolved;
}

async function readSummary(directory: string): Promise<unknown> {
  const path = join(directory, "summary.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("paper report summary must be a regular file");
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error("paper report summary is invalid JSON", { cause: error });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableWrite(path: string, value: string): Promise<void> {
  let handle: FileHandle | null = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(dirname(path));
  } finally { await handle?.close(); }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: npm run paper:cohort-report -- --input /absolute/report-dir [--input /absolute/report-dir] --output /absolute/new-cohort-directory\n");
    return;
  }
  const sources = inputs();
  const outputInput = argument("--output");
  if (sources.length === 0) throw new Error("paper:cohort-report requires at least one --input");
  if (outputInput === undefined || !isAbsolute(outputInput)) throw new Error("paper:cohort-report requires an absolute --output directory");
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const reportDirectories = await Promise.all(sources.map((source) => regularDirectory(source, "paper report input")));
  if (reportDirectories.some((directory) => inside(repository, directory))) {
    throw new Error("paper cohort inputs must remain outside Git");
  }
  const outputDirectory = resolve(outputInput);
  if (inside(repository, outputDirectory)) throw new Error("paper cohort output must remain outside Git");
  const parent = dirname(outputDirectory);
  if (await realpath(parent) !== parent) throw new Error("paper cohort output parent must not contain symlinks");
  const filesystem = await statfs(parent);
  if (new Set([0x01021997, 0x5346544e, 0x65735546]).has(Number(filesystem.type))) {
    throw new Error("paper cohort output requires a Linux-native filesystem");
  }
  const cohort = buildKJPaperCohortReport(await Promise.all(reportDirectories.map(async (directory) => ({
    sourcePath: join(directory, "summary.json"), artifact: await readSummary(directory),
  }))));
  const cohortHash = kjPaperCohortReportHash(cohort);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await syncDirectory(parent);
  await durableWrite(join(outputDirectory, "summary.json"), `${JSON.stringify({ cohort, cohortHash }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ accepted: true, runCount: cohort.runCount, cohortHash, outputDirectory })}\n`);
}

await main();
