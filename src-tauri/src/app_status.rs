use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const APP_STATUS_SCHEMA_V1: &str = "app-status-v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppMode {
    PaperOnly,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModuleAvailability {
    Available,
    Unavailable { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleStatus {
    pub module_id: String,
    pub availability: ModuleAvailability,
}

impl ModuleStatus {
    #[must_use]
    pub fn available(module_id: impl Into<String>) -> Self {
        Self {
            module_id: module_id.into(),
            availability: ModuleAvailability::Available,
        }
    }

    #[must_use]
    pub fn unavailable(module_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            module_id: module_id.into(),
            availability: ModuleAvailability::Unavailable {
                reason: reason.into(),
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppStatusV1 {
    schema_version: String,
    generated_at_utc: String,
    app_version: String,
    mode: AppMode,
    live_trading_enabled: bool,
    data_root_configured: bool,
    modules: Vec<ModuleStatus>,
}

impl AppStatusV1 {
    pub fn paper_only(
        generated_at_utc: impl Into<String>,
        app_version: impl Into<String>,
        data_root_configured: bool,
        modules: Vec<ModuleStatus>,
    ) -> Result<Self, AppStatusError> {
        let generated_at_utc = generated_at_utc.into();
        let app_version = app_version.into();
        validate_utc_timestamp(&generated_at_utc)?;
        if app_version.trim().is_empty() {
            return Err(AppStatusError::EmptyAppVersion);
        }

        let mut module_ids = BTreeSet::new();
        for module in &modules {
            if module.module_id.trim().is_empty() {
                return Err(AppStatusError::EmptyModuleId);
            }
            if !module_ids.insert(module.module_id.as_str()) {
                return Err(AppStatusError::DuplicateModuleId(module.module_id.clone()));
            }
            if let ModuleAvailability::Unavailable { reason } = &module.availability
                && reason.trim().is_empty()
            {
                return Err(AppStatusError::EmptyUnavailableReason(
                    module.module_id.clone(),
                ));
            }
        }

        Ok(Self {
            schema_version: APP_STATUS_SCHEMA_V1.to_owned(),
            generated_at_utc,
            app_version,
            mode: AppMode::PaperOnly,
            live_trading_enabled: false,
            data_root_configured,
            modules,
        })
    }

    #[must_use]
    pub fn schema_version(&self) -> &str {
        &self.schema_version
    }

    #[must_use]
    pub fn generated_at_utc(&self) -> &str {
        &self.generated_at_utc
    }

    #[must_use]
    pub fn app_version(&self) -> &str {
        &self.app_version
    }

    #[must_use]
    pub const fn mode(&self) -> &AppMode {
        &self.mode
    }

    #[must_use]
    pub const fn live_trading_enabled(&self) -> bool {
        self.live_trading_enabled
    }

    #[must_use]
    pub const fn data_root_configured(&self) -> bool {
        self.data_root_configured
    }

    #[must_use]
    pub fn modules(&self) -> &[ModuleStatus] {
        &self.modules
    }
}

pub trait UtcClock {
    fn now_utc(&self) -> Result<String, AppStatusError>;
}

pub trait ModuleProbe {
    fn module_statuses(&self) -> Vec<ModuleStatus>;
}

pub trait DataRootProbe {
    fn is_configured(&self) -> bool;
}

pub struct AppStatusService<C, M, D> {
    clock: C,
    module_probe: M,
    data_root_probe: D,
    app_version: String,
}

impl<C, M, D> AppStatusService<C, M, D>
where
    C: UtcClock,
    M: ModuleProbe,
    D: DataRootProbe,
{
    #[must_use]
    pub fn new(
        clock: C,
        module_probe: M,
        data_root_probe: D,
        app_version: impl Into<String>,
    ) -> Self {
        Self {
            clock,
            module_probe,
            data_root_probe,
            app_version: app_version.into(),
        }
    }

    pub fn get_status(&self) -> Result<AppStatusV1, AppStatusError> {
        AppStatusV1::paper_only(
            self.clock.now_utc()?,
            self.app_version.clone(),
            self.data_root_probe.is_configured(),
            self.module_probe.module_statuses(),
        )
    }
}

pub struct SystemUtcClock;

impl UtcClock for SystemUtcClock {
    fn now_utc(&self) -> Result<String, AppStatusError> {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AppStatusError::ClockBeforeUnixEpoch)?
            .as_secs();
        Ok(format_unix_seconds(seconds))
    }
}

pub struct RepositoryModuleProbe {
    repository_root: PathBuf,
}

impl RepositoryModuleProbe {
    #[must_use]
    pub fn new(repository_root: impl Into<PathBuf>) -> Self {
        Self {
            repository_root: repository_root.into(),
        }
    }

    fn status_for(&self, module_id: &str, relative_path: &Path) -> ModuleStatus {
        if self.repository_root.join(relative_path).is_dir() {
            ModuleStatus::available(module_id)
        } else {
            ModuleStatus::unavailable(module_id, "module directory is missing")
        }
    }
}

impl ModuleProbe for RepositoryModuleProbe {
    fn module_statuses(&self) -> Vec<ModuleStatus> {
        vec![
            self.status_for("typescript-execution", Path::new("backend/core/src")),
            self.status_for("python-research", Path::new("research/polymarket_money")),
            self.status_for("tauri-bridge", Path::new("src-tauri/src")),
        ]
    }
}

pub struct EnvironmentDataRootProbe;

impl DataRootProbe for EnvironmentDataRootProbe {
    fn is_configured(&self) -> bool {
        std::env::var_os("POLYMARKET_DATA_ROOT")
            .filter(|value| !value.is_empty())
            .is_some_and(|value| Path::new(&value).is_absolute())
    }
}

fn validate_utc_timestamp(value: &str) -> Result<(), AppStatusError> {
    let bytes = value.as_bytes();
    let separators_are_valid = bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.get(19) == Some(&b'Z');
    let digit_positions = [
        0_usize, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18,
    ];
    if bytes.len() != 20
        || !separators_are_valid
        || !digit_positions
            .iter()
            .all(|position| bytes[*position].is_ascii_digit())
    {
        return Err(AppStatusError::InvalidUtcTimestamp(value.to_owned()));
    }
    let parse = |start: usize, end: usize| {
        value[start..end]
            .parse::<u32>()
            .map_err(|_| AppStatusError::InvalidUtcTimestamp(value.to_owned()))
    };
    let year = parse(0, 4)?;
    let month = parse(5, 7)?;
    let day = parse(8, 10)?;
    let hour = parse(11, 13)?;
    let minute = parse(14, 16)?;
    let second = parse(17, 19)?;
    let leap_year =
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0
        || day == 0
        || day > days_in_month
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(AppStatusError::InvalidUtcTimestamp(value.to_owned()));
    }
    Ok(())
}

fn format_unix_seconds(seconds: u64) -> String {
    let days = i64::try_from(seconds / 86_400).expect("supported timestamp range");
    let seconds_in_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096)
            / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppStatusError {
    InvalidUtcTimestamp(String),
    EmptyAppVersion,
    EmptyModuleId,
    DuplicateModuleId(String),
    EmptyUnavailableReason(String),
    ClockBeforeUnixEpoch,
}

impl Display for AppStatusError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUtcTimestamp(value) => write!(formatter, "invalid UTC timestamp: {value}"),
            Self::EmptyAppVersion => formatter.write_str("app version must not be empty"),
            Self::EmptyModuleId => formatter.write_str("module id must not be empty"),
            Self::DuplicateModuleId(module_id) => {
                write!(formatter, "duplicate module id: {module_id}")
            }
            Self::EmptyUnavailableReason(module_id) => {
                write!(formatter, "unavailable module {module_id} needs a reason")
            }
            Self::ClockBeforeUnixEpoch => formatter.write_str("clock is before the Unix epoch"),
        }
    }
}

impl Error for AppStatusError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct FixedClock;

    impl UtcClock for FixedClock {
        fn now_utc(&self) -> Result<String, AppStatusError> {
            Ok("2026-07-21T00:00:00Z".to_owned())
        }
    }

    struct FixedModules;

    impl ModuleProbe for FixedModules {
        fn module_statuses(&self) -> Vec<ModuleStatus> {
            vec![
                ModuleStatus::available("typescript-execution"),
                ModuleStatus::unavailable("python-research", "venv missing"),
            ]
        }
    }

    struct ConfiguredDataRoot;

    impl DataRootProbe for ConfiguredDataRoot {
        fn is_configured(&self) -> bool {
            true
        }
    }

    #[test]
    fn paper_status_cannot_enable_live_trading() {
        let status = AppStatusV1::paper_only(
            "2026-07-21T00:00:00Z",
            "0.1.0",
            false,
            vec![ModuleStatus::available("typescript-execution")],
        )
        .expect("valid status");
        assert_eq!(status.mode(), &AppMode::PaperOnly);
        assert!(!status.live_trading_enabled());
        assert_eq!(status.schema_version(), APP_STATUS_SCHEMA_V1);
    }

    #[test]
    fn invalid_statuses_fail_closed() {
        let duplicate = AppStatusV1::paper_only(
            "2026-07-21T00:00:00Z",
            "0.1.0",
            false,
            vec![
                ModuleStatus::available("python-research"),
                ModuleStatus::unavailable("python-research", "missing"),
            ],
        );
        assert_eq!(
            duplicate,
            Err(AppStatusError::DuplicateModuleId(
                "python-research".to_owned()
            ))
        );
        assert!(matches!(
            AppStatusV1::paper_only("2026-02-29T00:00:00Z", "0.1.0", false, vec![]),
            Err(AppStatusError::InvalidUtcTimestamp(_))
        ));
        assert!(AppStatusV1::paper_only(
            "2024-02-29T23:59:59Z",
            "0.1.0",
            false,
            vec![]
        )
        .is_ok());
    }

    #[test]
    fn service_composes_injected_read_only_probes() {
        let service =
            AppStatusService::new(FixedClock, FixedModules, ConfiguredDataRoot, "0.1.0");
        let status = service.get_status().expect("valid status");
        assert!(!status.live_trading_enabled());
        assert!(status.data_root_configured());
        assert_eq!(status.modules().len(), 2);
    }

    #[test]
    fn repository_probe_reports_presence_only() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("polymarket-money-probe-{suffix}"));
        fs::create_dir_all(root.join("backend/core/src")).expect("create fixture directory");
        let statuses = RepositoryModuleProbe::new(&root).module_statuses();
        assert_eq!(statuses[0].availability, ModuleAvailability::Available);
        assert!(matches!(
            statuses[1].availability,
            ModuleAvailability::Unavailable { .. }
        ));
        fs::remove_dir_all(root).expect("remove fixture directory");
    }

    #[test]
    fn formats_known_utc_boundaries() {
        assert_eq!(format_unix_seconds(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_unix_seconds(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_unix_seconds(1_784_592_000), "2026-07-21T00:00:00Z");
    }
}
