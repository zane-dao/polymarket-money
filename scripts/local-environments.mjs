import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const localRoot = resolve(repositoryRoot, ".local");
const releasesRoot = resolve(localRoot, "releases");
const pointersRoot = resolve(localRoot, "pointers");
const dataBase = process.env.POLYMARKET_SIM_DATA_BASE ?? "/root/polymarket-money-data";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited ${code ?? signal}`)));
  });
}

async function output(command, args) {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "inherit"] });
    let value = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { value += chunk; });
    child.once("error", rejectOutput);
    child.once("exit", (code) => code === 0 ? resolveOutput(value.trim()) : rejectOutput(new Error(`${command} exited ${code}`)));
  });
}

async function artifactFingerprint(paths) {
  const hash = createHash("sha256");
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "__pycache__" || entry.name === "datasets") continue;
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        hash.update(relative(repositoryRoot, child));
        hash.update("\0");
        hash.update(await readFile(child));
        hash.update("\0");
      }
    }
  }
  for (const path of paths) await visit(path);
  return hash.digest("hex").slice(0, 12);
}

async function buildCandidate() {
  await run("npm", ["run", "build"]);
  await run("npm", ["run", "frontend:build"]);
  const commit = await output("git", ["rev-parse", "--short=12", "HEAD"]);
  const sourceBranch = await output("git", ["branch", "--show-current"]);
  const clean = (await output("git", ["status", "--porcelain"])) === "";
  const fingerprint = await artifactFingerprint([resolve(repositoryRoot, "dist"), resolve(repositoryRoot, "frontend", "dist"), resolve(repositoryRoot, "scripts"), resolve(repositoryRoot, "strategies"), resolve(repositoryRoot, "research", "polymarket_money")]);
  const releaseId = `${commit}-${fingerprint}`;
  const releaseRoot = resolve(releasesRoot, releaseId);
  const temporary = resolve(releasesRoot, `.partial-${process.pid}-${releaseId}`);
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { mode: 0o700 });
  await mkdir(resolve(temporary, "scripts"), { mode: 0o700 });
  await cp(resolve(repositoryRoot, "dist"), resolve(temporary, "dist"), { recursive: true, errorOnExist: true });
  await cp(resolve(repositoryRoot, "frontend", "dist"), resolve(temporary, "frontend", "dist"), { recursive: true, errorOnExist: true });
  await cp(resolve(repositoryRoot, "scripts", "run_workbench_backtest.py"), resolve(temporary, "scripts", "run_workbench_backtest.py"));
  await cp(resolve(repositoryRoot, "strategies"), resolve(temporary, "strategies"), { recursive: true, filter: (source) => !source.includes("__pycache__") });
  await cp(resolve(repositoryRoot, "research"), resolve(temporary, "research"), { recursive: true, filter: (source) => !source.includes("__pycache__") && !source.includes("datasets") });
  await writeFile(resolve(temporary, "release.json"), `${JSON.stringify({ releaseId, sourceBranch, commit, cleanSource: clean, artifactFingerprint: fingerprint, builtAtUtc: new Date().toISOString(), liveTradingEnabled: false }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, releaseRoot).catch(async (error) => {
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(pointersRoot, { recursive: true, mode: 0o700 });
  await writeFile(resolve(pointersRoot, "candidate"), `${releaseId}\n`, { mode: 0o600 });
  process.stdout.write(`Candidate release: ${releaseId}\n`);
}

async function pointer(name) {
  const releaseId = (await readFile(resolve(pointersRoot, name), "utf8").catch(() => { throw new Error(`${name} release is unavailable; build or promote it first`); })).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(releaseId)) throw new Error(`${name} release pointer is invalid`);
  const releaseRoot = resolve(releasesRoot, releaseId);
  const metadata = JSON.parse(await readFile(resolve(releaseRoot, "release.json"), "utf8"));
  if (metadata.releaseId !== releaseId || metadata.liveTradingEnabled !== false) throw new Error(`${name} release metadata is invalid`);
  return { releaseId, releaseRoot, metadata };
}

async function promote() {
  const { releaseId, metadata } = await pointer("candidate");
  if (metadata.sourceBranch !== "main" || metadata.cleanSource !== true) throw new Error("stable promotion requires a candidate built from a clean main checkout");
  await mkdir(pointersRoot, { recursive: true, mode: 0o700 });
  const temporary = resolve(pointersRoot, `.stable-${process.pid}.partial`);
  await writeFile(temporary, `${releaseId}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, resolve(pointersRoot, "stable"));
  process.stdout.write(`Promoted unchanged release to stable: ${releaseId}\n`);
}

async function serve(kind) {
  const production = kind === "production";
  const { releaseId, releaseRoot, metadata } = await pointer(production ? "stable" : "candidate");
  if (production && (metadata.sourceBranch !== "main" || metadata.cleanSource !== true)) throw new Error("production-sim requires a stable release built from a clean main checkout");
  const environment = production ? "production-sim" : "staging-sim";
  const port = production ? "4173" : "4273";
  const dataRoot = resolve(dataBase, environment);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await run("/usr/local/bin/node", [resolve(releaseRoot, "dist", "scripts", "workbench-web-server.js")], { cwd: releaseRoot, env: { PATH: "/usr/bin:/bin", POLYMARKET_ENV: environment, POLYMARKET_RELEASE_ID: releaseId, POLYMARKET_DATA_ROOT: dataRoot, POLYMARKET_WEB_PORT: port } });
}

async function dev() {
  await run("npm", ["run", "build"]);
  const dataRoot = resolve(dataBase, "staging-sim");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const environment = { ...process.env, POLYMARKET_ENV: "staging-sim", POLYMARKET_RELEASE_ID: "workspace", POLYMARKET_DATA_ROOT: dataRoot, POLYMARKET_WEB_PORT: "4273", POLYMARKET_DEV_BACKEND: "http://127.0.0.1:4273" };
  const backend = spawn("/usr/local/bin/node", [resolve(repositoryRoot, "dist", "scripts", "workbench-web-server.js")], { cwd: repositoryRoot, stdio: "inherit", env: environment });
  const vite = spawn("npm", ["run", "frontend:dev"], { cwd: repositoryRoot, stdio: "inherit", env: environment });
  const stop = () => { backend.kill("SIGTERM"); vite.kill("SIGTERM"); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const first = await Promise.race([new Promise((resolveExit) => backend.once("exit", (code) => resolveExit(["backend", code]))), new Promise((resolveExit) => vite.once("exit", (code) => resolveExit(["vite", code])))]);
  stop();
  const [name, code] = first;
  if (code !== 0 && code !== null) throw new Error(`${name} exited ${code}`);
}

const [command, argument] = process.argv.slice(2);
if (command === "build-candidate") await buildCandidate();
else if (command === "promote") await promote();
else if (command === "serve" && (argument === "production" || argument === "staging")) await serve(argument);
else if (command === "dev") await dev();
else throw new Error("usage: local-environments.mjs build-candidate|promote|serve production|serve staging|dev");
