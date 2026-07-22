use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

const HOST_RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);

struct RunningHost {
    child: Child,
    stdin: ChildStdin,
    responses: mpsc::Receiver<String>,
}

pub struct PaperHostBridge {
    process: Mutex<Option<RunningHost>>,
    next_request: AtomicU64,
}

impl Default for PaperHostBridge {
    fn default() -> Self {
        Self { process: Mutex::new(None), next_request: AtomicU64::new(1) }
    }
}

impl PaperHostBridge {
    pub fn is_running(&self) -> Result<bool, String> {
        let mut guard = self.process.lock().map_err(|_| "Paper host lock is poisoned".to_owned())?;
        if let Some(running) = guard.as_mut() {
            if running.child.try_wait().map_err(|_| "failed to inspect Paper host".to_owned())?.is_some() {
                *guard = None;
            }
        }
        Ok(guard.is_some())
    }

    pub fn start_and_request(&self, command: &str, payload: Value) -> Result<Value, String> {
        let mut guard = self.process.lock().map_err(|_| "Paper host lock is poisoned".to_owned())?;
        if guard.is_none() { *guard = Some(spawn_host()?); }
        request(guard.as_mut().expect("Paper host was inserted"), &self.next_request, command, payload)
            .inspect_err(|_| terminate(&mut guard))
    }

    pub fn request_if_running(&self, command: &str, payload: Value) -> Result<Option<Value>, String> {
        let mut guard = self.process.lock().map_err(|_| "Paper host lock is poisoned".to_owned())?;
        let Some(running) = guard.as_mut() else { return Ok(None); };
        if running.child.try_wait().map_err(|_| "failed to inspect Paper host".to_owned())?.is_some() {
            *guard = None; return Ok(None);
        }
        match request(running, &self.next_request, command, payload) {
            Ok(value) => Ok(Some(value)),
            Err(error) => { terminate(&mut guard); Err(error) }
        }
    }

    pub fn stop(&self) -> Result<Value, String> {
        let result = self.request_if_running("stop-public-feed", json!({}))?
            .unwrap_or_else(offline_status);
        let mut guard = self.process.lock().map_err(|_| "Paper host lock is poisoned".to_owned())?;
        terminate(&mut guard);
        Ok(result)
    }
}

impl Drop for PaperHostBridge {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.process.lock() { terminate(&mut guard); }
    }
}

pub fn offline_status() -> Value {
    json!({
        "schemaVersion": "paper-market-host-status-v1", "hostId": "desktop-paper-host", "feedId": "unconfigured",
        "source": "PUBLIC_MARKET_DATA", "executionMode": "PAPER_ONLY", "lifecycle": "STOPPED",
        "connection": "DISCONNECTED", "ready": false, "cachedMarketCount": 0, "snapshotCount": 0,
        "gapCount": 0, "errorCount": 0, "lastSnapshotAtUtc": null, "lastConnectionAtUtc": null, "events": []
    })
}

pub fn offline_strategy_status() -> Value {
    json!({
        "schemaVersion": "paper-strategy-runtime-v2", "status": "STOPPED",
        "executionAuthority": "PAPER_SESSION",
        "planner": { "engineVersion": "kj-paper-engine-v2", "journalRecordCount": 0,
            "recoveredInputCount": 0, "lastRecordHash": null, "error": null },
        "canonicalAccounts": [], "executionLinks": [],
        "shadow": { "nonAuthoritative": true, "snapshot": null, "events": [] }
    })
}

pub fn offline_market_runtime() -> Value {
    json!({
        "schemaVersion": "paper-market-runtime-v1", "status": "STOPPED",
        "checkedAtUtc": "1970-01-01T00:00:00.000Z", "market": null
    })
}

fn repository_root() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf)
        .ok_or_else(|| "repository root is unavailable".to_owned())?.canonicalize()
        .map_err(|_| "repository root is unavailable".to_owned())
}

fn fixed_host_script() -> Result<PathBuf, String> {
    let expected = repository_root()?.join("dist/scripts/paper-market-host.js");
    let canonical = expected.canonicalize().map_err(|_| "Paper host artifact is unavailable; run npm run build".to_owned())?;
    if canonical != expected || !canonical.is_file() { return Err("Paper host must be the fixed repository artifact".to_owned()); }
    Ok(canonical)
}

fn spawn_host() -> Result<RunningHost, String> {
    let data_root = std::env::var_os("POLYMARKET_DATA_ROOT").ok_or_else(|| "POLYMARKET_DATA_ROOT is required".to_owned())?;
    if !Path::new(&data_root).is_absolute() { return Err("POLYMARKET_DATA_ROOT must be absolute".to_owned()); }
    let mut child = Command::new("/usr/local/bin/node")
        .arg(fixed_host_script()?).current_dir(repository_root()?).env_clear()
        .env("PATH", "/usr/bin:/bin").env("POLYMARKET_DATA_ROOT", data_root)
        .env("LIVE_TRADING_ENABLED", "false")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "failed to start fixed Paper host".to_owned())?;
    let stdin = child.stdin.take().ok_or_else(|| "Paper host stdin is unavailable".to_owned())?;
    let stdout = child.stdout.take().ok_or_else(|| "Paper host stdout is unavailable".to_owned())?;
    let (sender, responses) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => if sender.send(line).is_err() { break; },
            }
        }
    });
    Ok(RunningHost { child, stdin, responses })
}

fn request(running: &mut RunningHost, ordinal: &AtomicU64, command: &str, payload: Value) -> Result<Value, String> {
    let request_id = format!("tauri-{}", ordinal.fetch_add(1, Ordering::Relaxed));
    let line = serde_json::to_vec(&json!({ "schemaVersion": "paper-host-ipc-request-v1", "requestId": request_id, "command": command, "payload": payload }))
        .map_err(|_| "failed to encode Paper host request".to_owned())?;
    if line.len() > 1024 * 1024 { return Err("Paper host request exceeds limit".to_owned()); }
    running.stdin.write_all(&line).and_then(|_| running.stdin.write_all(b"\n")).and_then(|_| running.stdin.flush())
        .map_err(|_| "failed to write Paper host request".to_owned())?;
    let line = running.responses.recv_timeout(HOST_RESPONSE_TIMEOUT).map_err(|_| "Paper host response timed out".to_owned())?;
    if line.len() > 16 * 1024 * 1024 { return Err("Paper host response exceeds limit".to_owned()); }
    let response: Value = serde_json::from_str(&line).map_err(|_| "Paper host returned invalid JSON".to_owned())?;
    if response.get("schemaVersion").and_then(Value::as_str) != Some("paper-host-ipc-response-v1")
        || response.get("requestId").and_then(Value::as_str) != Some(&request_id) { return Err("Paper host response identity mismatch".to_owned()); }
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return response.get("result").cloned().ok_or_else(|| "Paper host response omitted result".to_owned());
    }
    Err(response.pointer("/error/message").and_then(Value::as_str).unwrap_or("Paper host request failed").to_owned())
}

fn terminate(guard: &mut Option<RunningHost>) {
    if let Some(mut running) = guard.take() { let _ = running.child.kill(); let _ = running.child.wait(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_strategy_runtime_is_explicitly_stopped_and_paper_only() {
        let value = offline_strategy_status();
        assert_eq!(value["schemaVersion"], "paper-strategy-runtime-v2");
        assert_eq!(value["status"], "STOPPED");
        assert_eq!(value["executionAuthority"], "PAPER_SESSION");
        assert_eq!(value["planner"]["engineVersion"], "kj-paper-engine-v2");
        assert_eq!(value["canonicalAccounts"], json!([]));
        assert_eq!(value["shadow"]["nonAuthoritative"], true);
    }

    #[test]
    fn offline_market_runtime_never_invents_a_quote() {
        let value = offline_market_runtime();
        assert_eq!(value["schemaVersion"], "paper-market-runtime-v1");
        assert_eq!(value["status"], "STOPPED");
        assert_eq!(value["market"], Value::Null);
    }
}
