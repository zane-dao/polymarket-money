import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("R2 wrapper is a thin single-session metrics-only launcher", async () => {
  const source = await readFile("scripts/batch-04b-r2-session.sh", "utf8");
  assert.match(source, /dist\/scripts\/live-runtime\.js paper/u);
  assert.match(source, /--record metrics/u);
  assert.match(source, /--duration-seconds "\$MAXIMUM_RUNTIME_SECONDS"/u);
  assert.match(source, /sha256sum --check --strict/u);
  assert.match(source, /systemd-run --user/u);
  assert.match(source, /setsid nohup/u);
  assert.match(source, /systemd_has_required_network_environment/u);
  assert.match(source, /manager_environment/u);
  assert.match(source, /refusing a second session/u);
  assert.doesNotMatch(source, /--record raw/u);
  assert.doesNotMatch(source, /User Channel|private key|seed phrase|OrderIntent|sendOrder|createOrder/u);
});
