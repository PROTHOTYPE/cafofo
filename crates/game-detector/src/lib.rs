//! Active process scanning, custom game catalog matching, and stateful
//! session tracking (`started_at_ms`) for Cafofo Rich Presence.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessesToUpdate, System};
use thiserror::Error;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Debug, Error)]
pub enum GameDetectorError {
    #[error("process scan failed: {0}")]
    ScanFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedProcess {
    pub pid: u32,
    pub name: String,
    pub executable_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownGameEntry {
    pub game_id: String,
    pub name: String,
    pub executables: Vec<String>,
    #[serde(default)]
    pub is_custom: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedGame {
    pub game_id: String,
    pub game_name: String,
    pub process_name: String,
    pub pid: u32,
    #[serde(default)]
    pub is_custom: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveGameSession {
    pub game_id: String,
    pub game_name: String,
    pub process_name: String,
    pub pid: u32,
    pub started_at_ms: u64,
    pub is_custom: bool,
}

/// Scans active OS processes and matches them against both the synchronized
/// Supabase `game_catalog` and user-configured custom games/programs.
pub struct GameDetector {
    system: System,
    catalog: Vec<KnownGameEntry>,
    custom_games: Vec<KnownGameEntry>,
    current_session: Option<ActiveGameSession>,
}

impl Default for GameDetector {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl GameDetector {
    pub fn new(catalog: Vec<KnownGameEntry>) -> Self {
        Self {
            system: System::new(),
            catalog,
            custom_games: Vec::new(),
            current_session: None,
        }
    }

    pub fn update_catalog(&mut self, catalog: Vec<KnownGameEntry>) {
        self.catalog = catalog;
    }

    pub fn set_custom_games(&mut self, custom_games: Vec<KnownGameEntry>) {
        self.custom_games = custom_games
            .into_iter()
            .map(|mut g| {
                g.is_custom = true;
                g
            })
            .collect();
    }

    pub fn add_custom_game(&mut self, mut entry: KnownGameEntry) {
        entry.is_custom = true;
        self.custom_games.retain(|g| g.game_id != entry.game_id);
        self.custom_games.push(entry);
    }

    pub fn remove_custom_game(&mut self, game_id: &str) -> bool {
        let before = self.custom_games.len();
        self.custom_games.retain(|g| g.game_id != game_id);
        self.custom_games.len() != before
    }

    pub fn custom_games(&self) -> &[KnownGameEntry] {
        &self.custom_games
    }

    pub fn current_session(&self) -> Option<&ActiveGameSession> {
        self.current_session.as_ref()
    }

    /// Snapshots currently running OS processes.
    pub fn list_processes(&mut self) -> Vec<DetectedProcess> {
        self.system.refresh_processes(ProcessesToUpdate::All, true);
        self.system
            .processes()
            .iter()
            .map(|(pid, process)| DetectedProcess {
                pid: pid.as_u32(),
                name: process.name().to_string_lossy().into_owned(),
                executable_path: process
                    .exe()
                    .map(|path| path.to_string_lossy().into_owned()),
            })
            .collect()
    }

    /// Scans active processes and returns matches against custom games and `catalog`.
    pub fn scan_active_games(&mut self) -> Result<Vec<DetectedGame>, GameDetectorError> {
        let processes = self.list_processes();
        Ok(match_processes_against_entries(
            &processes,
            &self.custom_games,
            &self.catalog,
        ))
    }

    /// Polls active processes and returns `Some(new_state)` **only** when the
    /// active game changes or closes. Keeps the original `started_at_ms` while
    /// the same game remains open.
    pub fn poll_change(&mut self) -> Option<Option<ActiveGameSession>> {
        let processes = self.list_processes();
        let matches =
            match_processes_against_entries(&processes, &self.custom_games, &self.catalog);
        self.reconcile_matches(&matches, current_unix_ms())
    }

    fn reconcile_matches(
        &mut self,
        matches: &[DetectedGame],
        now_ms: u64,
    ) -> Option<Option<ActiveGameSession>> {
        match (&self.current_session, matches.is_empty()) {
            (None, true) => None,
            (Some(_), true) => {
                self.current_session = None;
                Some(None)
            }
            (Some(current), false) => {
                // Custom user entries always have strict priority over global catalog games.
                let custom_override = !current.is_custom && matches.first().is_some_and(|m| m.is_custom);
                if !custom_override {
                    if let Some(still_running) =
                        matches.iter().find(|m| m.game_id == current.game_id)
                    {
                        if let Some(session) = self.current_session.as_mut() {
                            session.pid = still_running.pid;
                            session.process_name = still_running.process_name.clone();
                        }
                        return None;
                    }
                }

                let next = &matches[0];
                let session = ActiveGameSession {
                    game_id: next.game_id.clone(),
                    game_name: next.game_name.clone(),
                    process_name: next.process_name.clone(),
                    pid: next.pid,
                    started_at_ms: now_ms,
                    is_custom: next.is_custom,
                };
                self.current_session = Some(session.clone());
                Some(Some(session))
            }
            (None, false) => {
                let next = &matches[0];
                let session = ActiveGameSession {
                    game_id: next.game_id.clone(),
                    game_name: next.game_name.clone(),
                    process_name: next.process_name.clone(),
                    pid: next.pid,
                    started_at_ms: now_ms,
                    is_custom: next.is_custom,
                };
                self.current_session = Some(session.clone());
                Some(Some(session))
            }
        }
    }
}

/// Spawns an asynchronous background loop polling active processes at `interval`
/// and invoking `on_change` only when the active game starts, switches, or stops.
pub fn spawn_detection_loop<F>(
    detector: Arc<Mutex<GameDetector>>,
    interval: Duration,
    mut on_change: F,
) -> JoinHandle<()>
where
    F: FnMut(Option<ActiveGameSession>) + Send + 'static,
{
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            let changed = {
                let mut guard = detector.lock().await;
                guard.poll_change()
            };
            if let Some(next_session) = changed {
                tracing::debug!(?next_session, "active game presence changed");
                on_change(next_session);
            }
        }
    })
}

fn match_processes_against_entries(
    processes: &[DetectedProcess],
    custom_games: &[KnownGameEntry],
    catalog: &[KnownGameEntry],
) -> Vec<DetectedGame> {
    let mut matches = Vec::new();
    let mut seen_game_ids = std::collections::HashSet::new();

    for entry in custom_games.iter().chain(catalog.iter()) {
        if let Some(process) = processes.iter().find(|p| executable_matches(p, entry)) {
            if seen_game_ids.insert(entry.game_id.clone()) {
                matches.push(DetectedGame {
                    game_id: entry.game_id.clone(),
                    game_name: entry.name.clone(),
                    process_name: process.name.clone(),
                    pid: process.pid,
                    is_custom: entry.is_custom,
                });
            }
        }
    }

    matches
}

fn executable_matches(process: &DetectedProcess, entry: &KnownGameEntry) -> bool {
    let proc_name = normalize_exe_name(&process.name);
    let proc_path_name = process
        .executable_path
        .as_deref()
        .map(normalize_exe_name);

    entry.executables.iter().any(|exe| {
        let target = normalize_exe_name(exe);
        target == proc_name
            || proc_path_name
                .as_deref()
                .is_some_and(|p| p == target || process.executable_path.as_deref().is_some_and(|full| full.eq_ignore_ascii_case(exe)))
    })
}

fn normalize_exe_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let file_part = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(trimmed);
    file_part.to_ascii_lowercase()
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconcile_preserves_started_at_and_emits_only_on_change() {
        let mut detector = GameDetector::new(vec![KnownGameEntry {
            game_id: "cs2".into(),
            name: "Counter-Strike 2".into(),
            executables: vec!["cs2.exe".into()],
            is_custom: false,
        }]);

        let match_cs2 = vec![DetectedGame {
            game_id: "cs2".into(),
            game_name: "Counter-Strike 2".into(),
            process_name: "cs2.exe".into(),
            pid: 1234,
            is_custom: false,
        }];

        // Initial start emits change
        let first = detector.reconcile_matches(&match_cs2, 1000);
        assert_eq!(
            first,
            Some(Some(ActiveGameSession {
                game_id: "cs2".into(),
                game_name: "Counter-Strike 2".into(),
                process_name: "cs2.exe".into(),
                pid: 1234,
                started_at_ms: 1000,
                is_custom: false,
            }))
        );

        // Consecutive tick with same game emits None and preserves started_at_ms=1000
        assert_eq!(detector.reconcile_matches(&match_cs2, 6000), None);
        assert_eq!(detector.current_session().unwrap().started_at_ms, 1000);

        // Closing game emits Some(None)
        assert_eq!(detector.reconcile_matches(&[], 11000), Some(None));
        assert!(detector.current_session().is_none());
    }

    #[test]
    fn custom_games_take_priority_over_catalog_regardless_of_process_order() {
        let processes = vec![
            DetectedProcess {
                pid: 100,
                name: "cs2.exe".into(),
                executable_path: None,
            },
            DetectedProcess {
                pid: 200,
                name: "eldenring.exe".into(),
                executable_path: Some("C:\\Games\\eldenring.exe".into()),
            },
        ];
        let catalog = vec![KnownGameEntry {
            game_id: "cs2".into(),
            name: "Counter-Strike 2".into(),
            executables: vec!["cs2.exe".into()],
            is_custom: false,
        }];
        let custom = vec![KnownGameEntry {
            game_id: "custom:elden-ring".into(),
            name: "Elden Ring".into(),
            executables: vec!["eldenring.exe".into()],
            is_custom: true,
        }];

        let matches = match_processes_against_entries(&processes, &custom, &catalog);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].game_id, "custom:elden-ring");
        assert!(matches[0].is_custom);
    }
}
