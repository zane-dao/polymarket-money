import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const localRoot = resolve(repositoryRoot, ".local");
const releasesRoot = resolve(localRoot, "releases");
const pointersRoot = resolve(localRoot, "pointers");
const dataBase = process.env.POLYMARKET_SIM_DATA_BASE ?? "/root/polymarket-money-data";
const candidateUnit = "polymarket-staging-4273.service";
const candidatePort = 4273;
const developmentFrontendUnit = "polymarket-vite-4174.service";
const developmentFrontendPort = 4174;

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
  const fingerprint = await artifactFingerprint([resolve(repositoryRoot, "dist"), resolve(repositoryRoot, "frontend", "dist"), resolve(repositoryRoot, "contracts"), resolve(repositoryRoot, "scripts"), resolve(repositoryRoot, "strategies"), resolve(repositoryRoot, "research", "polymarket_money")]);
  const releaseId = `${commit}-${fingerprint}`;
  const releaseRoot = resolve(releasesRoot, releaseId);
  const temporary = resolve(releasesRoot, `.partial-${process.pid}-${releaseId}`);
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { mode: 0o700 });
  await mkdir(resolve(temporary, "scripts"), { mode: 0o700 });
  await cp(resolve(repositoryRoot, "dist"), resolve(temporary, "dist"), { recursive: true, errorOnExist: true });
  await cp(resolve(repositoryRoot, "frontend", "dist"), resolve(temporary, "frontend", "dist"), { recursive: true, errorOnExist: true });
  await cp(resolve(repositoryRoot, "contracts"), resolve(temporary, "contracts"), { recursive: true, errorOnExist: true });
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
  return releaseId;
}

async function commandOnCandidate(command, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${candidatePort}/api/commands/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workbench-client": "web-v1" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`candidate command ${command} returned HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope === null || typeof envelope !== "object" || envelope.ok !== true) throw new Error(`candidate command ${command} returned an invalid response`);
  return envelope.result;
}

function hasModule(status, moduleId) {
  return status !== null && typeof status === "object" && Array.isArray(status.modules) && status.modules.some((item) => item !== null && typeof item === "object" && item.moduleId === moduleId && item.availability === "available");
}

async function waitForCandidateRelease(releaseId) {
  let lastError = "candidate did not answer";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const status = await commandOnCandidate("get_app_status_v1");
      if (hasModule(status, "runtime-environment:staging-sim") && hasModule(status, `release:${releaseId}`) && status.liveTradingEnabled === false) return;
      lastError = "candidate answered with a different release, environment, or live-trading state";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`candidate ${releaseId} was not verified on 127.0.0.1:${candidatePort}: ${lastError}`);
}

async function assertWarningRegression() {
  const j = await commandOnCandidate("validate_strategy_parameters_v1", { strategyId: "J_FEE_AWARE", parameters: { edgeThreshold: 0.05, maxEdge: 0.05, maxStakeUsdc: 400, bookParticipation: 0.5 } });
  const l = await commandOnCandidate("validate_strategy_parameters_v1", { strategyId: "L_ADAPTIVE_EXECUTION_V2", parameters: { maxSignalEdge: 0, maxStakeUsdc: 400, bookParticipation: 0.5 } });
  if (j?.valid !== true || !Array.isArray(j.warnings) || !j.warnings.some((warning) => warning?.code === "EMPTY_EDGE_WINDOW" && warning?.severity === "danger")) throw new Error("candidate did not return the expected J/K research warning");
  if (l?.valid !== true || !Array.isArray(l.warnings) || !l.warnings.some((warning) => warning?.code === "ZERO_SIGNAL_EDGE_GUARD" && warning?.severity === "danger")) throw new Error("candidate did not return the expected L research warning");
}

async function restartOrStartCandidateService() {
  await run("systemctl", ["--user", "stop", candidateUnit]).catch(() => undefined);
  const proxyEnvironment = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
    .flatMap((name) => process.env[name] === undefined ? [] : [`--setenv=${name}=${process.env[name]}`]);
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await run("systemd-run", ["--user", "--unit=polymarket-staging-4273", "--collect", `--property=WorkingDirectory=${repositoryRoot}`, "--setenv=PATH=/usr/local/bin:/usr/bin:/bin", ...proxyEnvironment, "/usr/local/bin/node", resolve(repositoryRoot, "scripts", "local-environments.mjs"), "serve", "staging"]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw lastError ?? new Error("candidate service could not be restarted");
}

async function restartActiveDevelopmentFrontend() {
  try {
    if (await output("systemctl", ["--user", "is-active", developmentFrontendUnit]) !== "active") return false;
  } catch {
    return false;
  }
  await run("systemctl", ["--user", "restart", developmentFrontendUnit]);
  let lastError = "development frontend did not answer";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${developmentFrontendPort}/`, { signal: AbortSignal.timeout(1_000) });
      const html = await response.text();
      if (response.ok && html.includes('id="root"')) return true;
      lastError = `development frontend returned HTTP ${response.status} or an unexpected document`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`active development frontend was not verified on 127.0.0.1:${developmentFrontendPort}: ${lastError}`);
}

async function refreshCandidate() {
  const releaseId = await buildCandidate();
  await restartOrStartCandidateService();
  await waitForCandidateRelease(releaseId);
  await assertWarningRegression();
  const developmentFrontendRestarted = await restartActiveDevelopmentFrontend();
  process.stdout.write(`Candidate refreshed and verified: ${releaseId} on 127.0.0.1:${candidatePort}\n`);
  if (developmentFrontendRestarted) process.stdout.write(`Active development frontend restarted and verified on 127.0.0.1:${developmentFrontendPort}\n`);
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
  await run("/usr/local/bin/node", ["--use-env-proxy", resolve(releaseRoot, "dist", "scripts", "workbench-web-server.js")], { cwd: releaseRoot, env: { ...process.env, PATH: "/usr/bin:/bin", POLYMARKET_ENV: environment, POLYMARKET_RELEASE_ID: releaseId, POLYMARKET_DATA_ROOT: dataRoot, POLYMARKET_WEB_PORT: port } });
}

async function dev() {
  await run("npm", ["run", "build"]);
  const dataRoot = resolve(dataBase, "staging-sim");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const environment = { ...process.env, POLYMARKET_ENV: "staging-sim", POLYMARKET_RELEASE_ID: "workspace", POLYMARKET_DATA_ROOT: dataRoot, POLYMARKET_WEB_PORT: "4273", POLYMARKET_DEV_BACKEND: "http://127.0.0.1:4273" };
  const backend = spawn("/usr/local/bin/node", ["--use-env-proxy", resolve(repositoryRoot, "dist", "scripts", "workbench-web-server.js")], { cwd: repositoryRoot, stdio: "inherit", env: environment });
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
else if (command === "refresh-candidate") await refreshCandidate();
else if (command === "promote") await promote();
else if (command === "serve" && (argument === "production" || argument === "staging")) await serve(argument);
else if (command === "dev") await dev();
else throw new Error("usage: local-environments.mjs build-candidate|refresh-candidate|promote|serve production|serve staging|dev");
