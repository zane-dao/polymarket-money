import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const npmPath = resolve(dirname(process.execPath), "npm");
const services = [
  {
    name: "production",
    unit: "polymarket-production-4173.service",
    port: 4173,
    npmArgs: ["run", "sim:production"],
  },
  {
    name: "staging",
    unit: "polymarket-staging-4273.service",
    port: 4273,
    npmArgs: ["run", "sim:staging"],
  },
  {
    name: "vite",
    unit: "polymarket-vite-4174.service",
    port: 4174,
    npmArgs: ["run", "frontend:dev", "--", "--host", "127.0.0.1"],
    environment: ["POLYMARKET_DEV_BACKEND=http://127.0.0.1:4273"],
  },
];

function run(command, args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} exited ${result.status}`);
  }
  return result;
}

function unitIsActive(unit) {
  return run("systemctl", ["--user", "is-active", "--quiet", unit], { allowFailure: true, capture: true }).status === 0;
}

function portIsOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(350);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(port, expectedOpen) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await portIsOpen(port) === expectedOpen) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`port ${port} did not become ${expectedOpen ? "ready" : "closed"}`);
}

async function startService(service) {
  if (unitIsActive(service.unit)) {
    process.stdout.write(`${service.port} ${service.name}: already running\n`);
    return;
  }
  if (await portIsOpen(service.port)) {
    throw new Error(`port ${service.port} is occupied by a process not managed by ${service.unit}`);
  }
  run("systemctl", ["--user", "reset-failed", service.unit], { allowFailure: true, capture: true });
  const args = [
    "--user",
    `--unit=${service.unit.replace(/\.service$/u, "")}`,
    "--collect",
    `--property=WorkingDirectory=${repositoryRoot}`,
    "--setenv=PATH=/usr/local/bin:/usr/bin:/bin",
    ...(service.environment ?? []).map((entry) => `--setenv=${entry}`),
    npmPath,
    ...service.npmArgs,
  ];
  run("systemd-run", args);
  await waitForPort(service.port, true);
  process.stdout.write(`${service.port} ${service.name}: started\n`);
}

async function stopService(service) {
  if (!unitIsActive(service.unit)) {
    process.stdout.write(`${service.port} ${service.name}: already stopped\n`);
    return;
  }
  run("systemctl", ["--user", "stop", service.unit]);
  await waitForPort(service.port, false);
  process.stdout.write(`${service.port} ${service.name}: stopped\n`);
}

async function showStatus() {
  for (const service of services) {
    const active = unitIsActive(service.unit);
    const open = await portIsOpen(service.port);
    process.stdout.write(`${service.port} ${service.name}: unit=${active ? "active" : "inactive"}, port=${open ? "open" : "closed"}\n`);
  }
}

async function runEvery(items, operation) {
  const failures = [];
  for (const item of items) {
    try {
      await operation(item);
    } catch (error) {
      failures.push(`${item.port} ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`one or more port operations failed:\n${failures.join("\n")}`);
}

const command = process.argv[2];
if (command === "start") {
  await runEvery(services, startService);
} else if (command === "stop") {
  await runEvery([...services].reverse(), stopService);
} else if (command === "restart") {
  await runEvery([...services].reverse(), stopService);
  await runEvery(services, startService);
} else if (command === "status") {
  await showStatus();
} else {
  throw new Error("usage: local-ports.mjs start|stop|restart|status");
}
