use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use std::process::Command;
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::State;

use crate::{
    AppMode, AppStatusService, EnvironmentDataRootProbe, ModuleAvailability,
    RepositoryModuleProbe, SystemUtcClock,
    PaperHostBridge,
};

const MAX_BACKEND_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_BACKEND_ERROR_BYTES: usize = 16 * 1024;
const BACKEND_TIMEOUT: Duration = Duration::from_secs(10);

fn read_bounded<R: Read + Send + 'static>(reader: R, limit: usize) -> thread::JoinHandle<Result<Vec<u8>, String>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        reader.take((limit + 1) as u64).read_to_end(&mut bytes)
            .map_err(|_| "failed to read workbench backend output".to_owned())?;
        if bytes.len() > limit { return Err("workbench backend output exceeded its limit".to_owned()); }
        Ok(bytes)
    })
}

fn repository_root() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "repository root is unavailable".to_owned())
}

fn backend_cli() -> Result<PathBuf, String> {
    if std::env::var_os("POLYMARKET_BACKEND_CLI").is_some() {
        return Err("POLYMARKET_BACKEND_CLI overrides are forbidden".to_owned());
    }
    let root = repository_root()?.canonicalize()
        .map_err(|_| "repository root is unavailable".to_owned())?;
    let expected = root.join("dist/scripts/workbench-command.js");
    let configured = expected.canonicalize()
        .map_err(|_| "workbench backend CLI is unavailable; run npm run build".to_owned())?;
    if configured != expected {
        return Err("workbench backend CLI must be the fixed repository artifact".to_owned());
    }
    let metadata = configured.metadata().map_err(|_| "workbench backend CLI is unavailable; run npm run build".to_owned())?;
    if !metadata.is_file() { return Err("workbench backend CLI must be a file".to_owned()); }
    Ok(configured)
}

fn is_backend_mode(mode: &str) -> bool {
    matches!(mode, "manifest" | "view" | "list-strategy-definitions" | "list-strategy-versions" | "get-strategy-version" | "validate-strategy-parameters" | "save-strategy-version" | "register-dataset-source" | "scan-datasets" | "list-datasets" | "get-dataset" | "validate-dataset-selection" | "start-backtest" | "get-backtest-job" | "list-backtest-jobs" | "stop-backtest" | "get-backtest-result" | "get-backtest-decisions" | "get-backtest-orders" | "get-backtest-fills" | "get-backtest-settlements" | "get-backtest-equity" | "get-backtest-replay" | "compare-backtests" | "get-system-health" | "list-system-incidents" | "get-paper-replay" | "list-paper-sessions" | "start-paper-session" | "get-paper-session-status" | "get-paper-session-detail" | "stop-paper-session" | "resume-paper-session" | "submit-paper-order" | "cancel-paper-order" | "reprice-paper-order" | "expire-paper-orders" | "settle-paper-market" | "get-paper-system-control" | "set-paper-kill-switch")
}

fn run_backend(mode: &str, payload: &Value) -> Result<Value, String> {
    if !is_backend_mode(mode) { return Err("unsupported backend mode".to_owned()); }
    let mut child = Command::new("/usr/local/bin/node")
        .arg(backend_cli()?)
        .arg(mode)
        .current_dir(repository_root()?)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("POLYMARKET_DATA_ROOT", std::env::var_os("POLYMARKET_DATA_ROOT").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "failed to start fixed workbench backend".to_owned())?;
    let input = serde_json::to_vec(payload).map_err(|_| "failed to encode backend payload".to_owned())?;
    child.stdin.take().ok_or_else(|| "backend stdin is unavailable".to_owned())?.write_all(&input).map_err(|_| "failed to write backend payload".to_owned())?;
    let stdout = read_bounded(child.stdout.take().ok_or_else(|| "backend stdout is unavailable".to_owned())?, MAX_BACKEND_OUTPUT_BYTES);
    let stderr = read_bounded(child.stderr.take().ok_or_else(|| "backend stderr is unavailable".to_owned())?, MAX_BACKEND_ERROR_BYTES);
    let deadline = Instant::now() + BACKEND_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "failed to wait for fixed workbench backend".to_owned())? { break status; }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err("workbench backend timed out".to_owned());
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = stdout.join().map_err(|_| "workbench backend stdout reader failed".to_owned())??;
    let stderr = stderr.join().map_err(|_| "workbench backend stderr reader failed".to_owned())??;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(if detail.is_empty() { "workbench backend failed".to_owned() } else { detail });
    }
    serde_json::from_slice(&stdout).map_err(|_| "workbench backend returned invalid JSON".to_owned())
}

#[tauri::command]
pub fn get_app_status_v1() -> Result<Value, String> {
    let root = repository_root()?;
    let service = AppStatusService::new(
        SystemUtcClock,
        RepositoryModuleProbe::new(root),
        EnvironmentDataRootProbe,
        env!("CARGO_PKG_VERSION"),
    );
    let status = service.get_status().map_err(|error| error.to_string())?;
    let mode = match status.mode() { AppMode::PaperOnly => "paper-only" };
    let modules = status.modules().iter().map(|module| match &module.availability {
        ModuleAvailability::Available => json!({ "moduleId": module.module_id, "availability": "available" }),
        ModuleAvailability::Unavailable { reason } => json!({ "moduleId": module.module_id, "availability": "unavailable", "reason": reason }),
    }).collect::<Vec<_>>();
    Ok(json!({
        "schemaVersion": status.schema_version(), "generatedAtUtc": status.generated_at_utc(),
        "appVersion": status.app_version(), "mode": mode,
        "liveTradingEnabled": status.live_trading_enabled(),
        "dataRootConfigured": status.data_root_configured(), "modules": modules,
    }))
}

#[tauri::command]
pub fn get_workbench_manifest_v1() -> Result<Value, String> { run_backend("manifest", &json!({})) }

#[tauri::command]
pub fn get_workbench_view_v1() -> Result<Value, String> { run_backend("view", &json!({})) }

#[tauri::command]
pub fn list_strategy_definitions_v1() -> Result<Value, String> { run_backend("list-strategy-definitions", &json!({})) }
#[tauri::command]
pub fn list_strategy_versions_v1(strategy_id: String) -> Result<Value, String> { run_backend("list-strategy-versions", &json!({ "strategyId": strategy_id })) }
#[tauri::command]
pub fn get_strategy_version_v1(strategy_id: String, version: String) -> Result<Value, String> { run_backend("get-strategy-version", &json!({ "strategyId": strategy_id, "version": version })) }
#[tauri::command]
pub fn validate_strategy_parameters_v1(strategy_id: String, parameters: Value) -> Result<Value, String> { run_backend("validate-strategy-parameters", &json!({ "strategyId": strategy_id, "parameters": parameters })) }
#[tauri::command]
pub fn save_strategy_version_v1(value: Value) -> Result<Value, String> { run_backend("save-strategy-version", &json!({ "value": value })) }

#[tauri::command]
pub fn scan_datasets_v1() -> Result<Value, String> { run_backend("scan-datasets", &json!({})) }
#[tauri::command]
pub fn register_dataset_source_v1(request: Value) -> Result<Value, String> { run_backend("register-dataset-source", &json!({ "request": request })) }
#[tauri::command]
pub fn list_datasets_v1() -> Result<Value, String> { run_backend("list-datasets", &json!({})) }
#[tauri::command]
pub fn get_dataset_v1(dataset_id: String, version_hash: String) -> Result<Value, String> { run_backend("get-dataset", &json!({ "datasetId": dataset_id, "versionHash": version_hash })) }
#[tauri::command]
pub fn validate_dataset_selection_v1(selection: Value) -> Result<Value, String> { run_backend("validate-dataset-selection", &json!({ "selection": selection })) }

#[tauri::command]
pub fn start_backtest_v1(request: Value) -> Result<Value, String> { run_backend("start-backtest", &json!({ "request": request })) }
#[tauri::command]
pub fn get_backtest_job_v1(run_id: String) -> Result<Value, String> { run_backend("get-backtest-job", &json!({ "runId": run_id })) }
#[tauri::command]
pub fn list_backtest_jobs_v1() -> Result<Value, String> { run_backend("list-backtest-jobs", &json!({})) }
#[tauri::command]
pub fn stop_backtest_v1(run_id: String) -> Result<Value, String> { run_backend("stop-backtest", &json!({ "runId": run_id })) }
#[tauri::command]
pub fn get_backtest_result_v1(run_id: String) -> Result<Value, String> { run_backend("get-backtest-result", &json!({ "runId": run_id })) }
#[tauri::command]
pub fn get_backtest_decisions_v1(run_id: String, page: Value) -> Result<Value, String> { run_backend("get-backtest-decisions", &json!({ "runId": run_id, "page": page })) }
#[tauri::command]
pub fn get_backtest_orders_v1(run_id: String, page: Value) -> Result<Value, String> { run_backend("get-backtest-orders", &json!({ "runId": run_id, "page": page })) }
#[tauri::command]
pub fn get_backtest_fills_v1(run_id: String, page: Value) -> Result<Value, String> { run_backend("get-backtest-fills", &json!({ "runId": run_id, "page": page })) }
#[tauri::command]
pub fn get_backtest_settlements_v1(run_id: String, page: Value) -> Result<Value, String> { run_backend("get-backtest-settlements", &json!({ "runId": run_id, "page": page })) }
#[tauri::command]
pub fn get_backtest_equity_v1(run_id: String, page: Value) -> Result<Value, String> { run_backend("get-backtest-equity", &json!({ "runId": run_id, "page": page })) }
#[tauri::command]
pub fn get_backtest_replay_v1(run_id: String, page: Value) -> Result<Value, String> { run_backend("get-backtest-replay", &json!({ "runId": run_id, "page": page })) }
#[tauri::command]
pub fn compare_backtests_v1(run_ids: Vec<String>) -> Result<Value, String> { run_backend("compare-backtests", &json!({ "runIds": run_ids })) }
#[tauri::command]
pub fn get_system_health_v1() -> Result<Value, String> { run_backend("get-system-health", &json!({})) }
#[tauri::command]
pub fn list_system_incidents_v1(page: Value) -> Result<Value, String> { run_backend("list-system-incidents", &json!({ "page": page })) }

#[tauri::command]
pub fn get_paper_market_host_status_v1(host: State<'_, PaperHostBridge>) -> Result<Value, String> {
    host.request_if_running("host-status", json!({})).map(|value| value.unwrap_or_else(crate::paper_host::offline_status))
}
#[tauri::command]
pub fn get_paper_market_runtime_v1(host: State<'_, PaperHostBridge>) -> Result<Value, String> {
    host.request_if_running("get-paper-market-runtime", json!({}))
        .map(|value| value.unwrap_or_else(crate::paper_host::offline_market_runtime))
}
#[tauri::command]
pub fn get_paper_strategy_runtime_v1(host: State<'_, PaperHostBridge>) -> Result<Value, String> {
    host.request_if_running("get-paper-strategy-runtime", json!({}))
        .map(|value| value.unwrap_or_else(crate::paper_host::offline_strategy_status))
}
#[tauri::command]
pub fn start_public_paper_market_host_v1(host: State<'_, PaperHostBridge>, slug: String, explicit_network_approval: bool) -> Result<Value, String> {
    if !explicit_network_approval { return Err("explicit network approval is required".to_owned()); }
    host.start_and_request("start-public-feed", json!({ "slug": slug, "explicitNetworkApproval": true }))
}
#[tauri::command]
pub fn stop_public_paper_market_host_v1(host: State<'_, PaperHostBridge>) -> Result<Value, String> { host.stop() }

fn paper_command(host: &State<'_, PaperHostBridge>, host_command: &str, backend_command: &str, payload: Value) -> Result<Value, String> {
    if let Some(value) = host.request_if_running(host_command, payload.clone())? { Ok(value) } else { run_backend(backend_command, &payload) }
}
#[tauri::command]
pub fn get_paper_replay_v1(host: State<'_, PaperHostBridge>, page: u64, page_size: u64) -> Result<Value, String> { paper_command(&host, "get-paper-replay", "get-paper-replay", json!({ "page": page, "pageSize": page_size })) }

#[tauri::command]
pub fn list_paper_sessions_v1(host: State<'_, PaperHostBridge>) -> Result<Value, String> { paper_command(&host, "list-paper-sessions", "list-paper-sessions", json!({})) }
#[tauri::command]
pub fn start_paper_session_v1(host: State<'_, PaperHostBridge>, request: Value) -> Result<Value, String> { paper_command(&host, "start-paper-session", "start-paper-session", json!({ "request": request })) }
#[tauri::command]
pub fn get_paper_session_status_v1(host: State<'_, PaperHostBridge>, session_id: String) -> Result<Value, String> { paper_command(&host, "get-paper-session-status", "get-paper-session-status", json!({ "sessionId": session_id })) }
#[tauri::command]
pub fn stop_paper_session_v1(host: State<'_, PaperHostBridge>, session_id: String) -> Result<Value, String> { paper_command(&host, "stop-paper-session", "stop-paper-session", json!({ "sessionId": session_id })) }
#[tauri::command]
pub fn resume_paper_session_v1(host: State<'_, PaperHostBridge>, session_id: String) -> Result<Value, String> { paper_command(&host, "resume-paper-session", "resume-paper-session", json!({ "sessionId": session_id })) }
#[tauri::command]
pub fn get_paper_session_detail_v1(host: State<'_, PaperHostBridge>, session_id: String) -> Result<Value, String> { paper_command(&host, "get-paper-session-detail", "get-paper-session-detail", json!({ "sessionId": session_id })) }
#[tauri::command]
pub fn submit_paper_order_v1(host: State<'_, PaperHostBridge>, session_id: String, request: Value) -> Result<Value, String> { paper_command(&host, "submit-paper-order", "submit-paper-order", json!({ "sessionId": session_id, "request": request })) }
#[tauri::command]
pub fn cancel_paper_order_v1(host: State<'_, PaperHostBridge>, session_id: String, order_id: String, reason: String) -> Result<Value, String> { paper_command(&host, "cancel-paper-order", "cancel-paper-order", json!({ "sessionId": session_id, "orderId": order_id, "reason": reason })) }
#[tauri::command]
pub fn reprice_paper_order_v1(host: State<'_, PaperHostBridge>, session_id: String, order_id: String, replacement: Value) -> Result<Value, String> { paper_command(&host, "reprice-paper-order", "reprice-paper-order", json!({ "sessionId": session_id, "orderId": order_id, "replacement": replacement })) }
#[tauri::command]
pub fn expire_paper_orders_v1(host: State<'_, PaperHostBridge>, session_id: String) -> Result<Value, String> { paper_command(&host, "expire-paper-orders", "expire-paper-orders", json!({ "sessionId": session_id })) }
#[tauri::command]
pub fn settle_paper_market_v1(host: State<'_, PaperHostBridge>, session_id: String, market_id: String, winning_token: String, evidence_mode: String) -> Result<Value, String> { paper_command(&host, "settle-paper-market", "settle-paper-market", json!({ "sessionId": session_id, "marketId": market_id, "winningToken": winning_token, "evidenceMode": evidence_mode })) }
#[tauri::command]
pub fn get_paper_system_control_v1(host: State<'_, PaperHostBridge>) -> Result<Value, String> { paper_command(&host, "get-paper-system-control", "get-paper-system-control", json!({})) }
#[tauri::command]
pub fn set_paper_kill_switch_v1(host: State<'_, PaperHostBridge>, enabled: bool, reason: String) -> Result<Value, String> { paper_command(&host, "set-paper-kill-switch", "set-paper-kill-switch", json!({ "enabled": enabled, "reason": reason })) }

#[cfg(test)]
mod tests {
    use super::is_backend_mode;

    #[test]
    fn read_only_query_modes_are_fixed_and_arbitrary_modes_are_rejected() {
        for mode in ["register-dataset-source", "get-backtest-decisions", "get-backtest-orders", "get-backtest-fills", "get-backtest-settlements", "get-backtest-equity", "get-backtest-replay", "compare-backtests", "get-system-health", "list-system-incidents"] {
            assert!(is_backend_mode(mode), "{mode} must be explicitly allowlisted");
        }
        assert!(!is_backend_mode("query"));
        assert!(!is_backend_mode("sql"));
        assert!(!is_backend_mode("../get-system-health"));
    }
}
