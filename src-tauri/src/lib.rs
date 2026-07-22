mod app_status;
mod commands;
mod paper_host;

pub use app_status::{
    APP_STATUS_SCHEMA_V1, AppMode, AppStatusError, AppStatusService, AppStatusV1,
    DataRootProbe, EnvironmentDataRootProbe, ModuleAvailability, ModuleProbe, ModuleStatus,
    RepositoryModuleProbe, SystemUtcClock, UtcClock,
};
pub use commands::{
    get_app_status_v1, get_backtest_job_v1, get_backtest_result_v1, get_backtest_decisions_v1,
    get_backtest_orders_v1, get_backtest_fills_v1, get_backtest_settlements_v1,
    get_backtest_equity_v1, get_backtest_replay_v1, compare_backtests_v1,
    get_system_health_v1, list_system_incidents_v1, get_dataset_v1,
    get_paper_replay_v1, get_paper_session_status_v1, get_paper_system_control_v1, get_strategy_version_v1, get_workbench_manifest_v1,
    get_paper_market_host_status_v1, get_paper_market_runtime_v1, get_paper_strategy_runtime_v1,
    start_public_paper_market_host_v1, stop_public_paper_market_host_v1,
    get_paper_session_detail_v1, submit_paper_order_v1, cancel_paper_order_v1,
    reprice_paper_order_v1, expire_paper_orders_v1, settle_paper_market_v1,
    get_workbench_view_v1, list_backtest_jobs_v1, list_datasets_v1, list_paper_sessions_v1,
    list_strategy_definitions_v1, list_strategy_versions_v1, save_strategy_version_v1,
    register_dataset_source_v1, resume_paper_session_v1, scan_datasets_v1, set_paper_kill_switch_v1, start_backtest_v1,
    start_paper_session_v1, stop_backtest_v1, stop_paper_session_v1,
    validate_dataset_selection_v1, validate_strategy_parameters_v1,
};
pub use paper_host::PaperHostBridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PaperHostBridge::default())
        .invoke_handler(tauri::generate_handler![
            get_app_status_v1,
            get_workbench_manifest_v1,
            get_workbench_view_v1,
            list_strategy_definitions_v1,
            list_strategy_versions_v1,
            get_strategy_version_v1,
            validate_strategy_parameters_v1,
            save_strategy_version_v1,
            register_dataset_source_v1,
            scan_datasets_v1,
            list_datasets_v1,
            get_dataset_v1,
            validate_dataset_selection_v1,
            start_backtest_v1,
            get_backtest_job_v1,
            list_backtest_jobs_v1,
            stop_backtest_v1,
            get_backtest_result_v1,
            get_backtest_decisions_v1,
            get_backtest_orders_v1,
            get_backtest_fills_v1,
            get_backtest_settlements_v1,
            get_backtest_equity_v1,
            get_backtest_replay_v1,
            compare_backtests_v1,
            get_system_health_v1,
            list_system_incidents_v1,
            list_paper_sessions_v1,
            get_paper_replay_v1,
            get_paper_market_host_status_v1,
            get_paper_market_runtime_v1,
            get_paper_strategy_runtime_v1,
            start_public_paper_market_host_v1,
            stop_public_paper_market_host_v1,
            start_paper_session_v1,
            get_paper_session_status_v1,
            stop_paper_session_v1,
            resume_paper_session_v1,
            get_paper_session_detail_v1,
            submit_paper_order_v1,
            cancel_paper_order_v1,
            reprice_paper_order_v1,
            expire_paper_orders_v1,
            settle_paper_market_v1,
            get_paper_system_control_v1,
            set_paper_kill_switch_v1,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run polymarket-money desktop app");
}
