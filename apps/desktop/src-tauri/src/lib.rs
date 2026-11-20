mod runtime;

use std::sync::Arc;

use cafofo_audio_engine::AudioDeviceInfo;
use cafofo_game_detector::{ActiveGameSession, DetectedProcess, KnownGameEntry};
use cafofo_screen_capture::{extract_exe_icon_data_url, WindowInfo};
use runtime::{AudioStatus, CafofoRuntime};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn health_check() -> &'static str {
    "ok"
}

#[tauri::command]
fn list_audio_input_devices(
    runtime: State<'_, Arc<CafofoRuntime>>,
) -> Result<Vec<AudioDeviceInfo>, String> {
    runtime.list_audio_inputs()
}

#[tauri::command]
fn list_capture_windows(runtime: State<'_, Arc<CafofoRuntime>>) -> Result<Vec<WindowInfo>, String> {
    runtime.list_windows()
}

#[tauri::command]
async fn join_voice_room(
    runtime: State<'_, Arc<CafofoRuntime>>,
    url: String,
    token: String,
    mic_device_id: Option<String>,
) -> Result<(), String> {
    runtime.join_voice_room(url, token, mic_device_id).await
}

#[tauri::command]
async fn leave_voice_room(runtime: State<'_, Arc<CafofoRuntime>>) -> Result<(), String> {
    runtime.leave_voice_room().await
}

#[tauri::command]
fn set_voice_controls(
    runtime: State<'_, Arc<CafofoRuntime>>,
    muted: Option<bool>,
    deafened: Option<bool>,
    rnnoise_enabled: Option<bool>,
) {
    runtime.set_voice_controls(muted, deafened, rnnoise_enabled);
}

#[tauri::command]
fn set_push_to_talk_key(runtime: State<'_, Arc<CafofoRuntime>>, vk_code: Option<u16>) {
    runtime.set_push_to_talk_key(vk_code);
}

#[tauri::command]
async fn get_audio_status(runtime: State<'_, Arc<CafofoRuntime>>) -> Result<AudioStatus, String> {
    Ok(runtime.audio_status().await)
}

#[tauri::command]
async fn start_window_share(
    runtime: State<'_, Arc<CafofoRuntime>>,
    hwnd: isize,
    pid: u32,
    target_fps: Option<u32>,
    share_audio: Option<bool>,
) -> Result<(), String> {
    runtime
        .start_window_share(hwnd, pid, target_fps, share_audio)
        .await
}

#[tauri::command]
async fn stop_window_share(runtime: State<'_, Arc<CafofoRuntime>>) -> Result<(), String> {
    runtime.stop_window_share().await
}

#[tauri::command]
async fn set_game_catalog(
    app: AppHandle,
    runtime: State<'_, Arc<CafofoRuntime>>,
    entries: Vec<KnownGameEntry>,
) -> Result<(), String> {
    runtime.set_game_catalog(app, entries).await;
    Ok(())
}

#[tauri::command]
async fn sync_custom_games(
    app: AppHandle,
    runtime: State<'_, Arc<CafofoRuntime>>,
    entries: Vec<KnownGameEntry>,
) -> Result<Vec<KnownGameEntry>, String> {
    runtime.sync_custom_games(app, entries).await
}

#[tauri::command]
fn extract_exe_icon(exe_path: String) -> Result<Option<String>, String> {
    extract_exe_icon_data_url(&exe_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_custom_games(
    runtime: State<'_, Arc<CafofoRuntime>>,
) -> Result<Vec<KnownGameEntry>, String> {
    Ok(runtime.list_custom_games().await)
}

#[tauri::command]
async fn add_custom_game(
    app: AppHandle,
    runtime: State<'_, Arc<CafofoRuntime>>,
    name: String,
    executable: String,
) -> Result<Vec<KnownGameEntry>, String> {
    runtime.add_custom_game(app, name, executable).await
}

#[tauri::command]
async fn remove_custom_game(
    app: AppHandle,
    runtime: State<'_, Arc<CafofoRuntime>>,
    game_id: String,
) -> Result<Vec<KnownGameEntry>, String> {
    runtime.remove_custom_game(app, game_id).await
}

#[tauri::command]
async fn get_active_game_session(
    runtime: State<'_, Arc<CafofoRuntime>>,
) -> Result<Option<ActiveGameSession>, String> {
    Ok(runtime.active_game_session().await)
}

#[tauri::command]
async fn list_running_processes(
    runtime: State<'_, Arc<CafofoRuntime>>,
) -> Result<Vec<DetectedProcess>, String> {
    Ok(runtime.list_running_processes().await)
}

#[tauri::command]
async fn play_entry_sound(
    runtime: State<'_, Arc<CafofoRuntime>>,
    url: String,
    volume: f32,
) -> Result<(), String> {
    runtime.play_entry_sound(url, volume).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("cafofo=info")),
        )
        .try_init();

    let runtime = Arc::new(CafofoRuntime::new());
    let runtime_for_setup = Arc::clone(&runtime);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(runtime)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let custom_games_file = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("cafofo"))
                .join("custom_games.json");

            tauri::async_runtime::spawn(async move {
                runtime_for_setup
                    .init_game_detector(app_handle, custom_games_file)
                    .await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            list_audio_input_devices,
            list_capture_windows,
            join_voice_room,
            leave_voice_room,
            set_voice_controls,
            set_push_to_talk_key,
            get_audio_status,
            start_window_share,
            stop_window_share,
            set_game_catalog,
            sync_custom_games,
            extract_exe_icon,
            list_custom_games,
            add_custom_game,
            remove_custom_game,
            get_active_game_session,
            list_running_processes,
            play_entry_sound,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cafofo desktop application");
}
