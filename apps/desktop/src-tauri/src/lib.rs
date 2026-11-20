mod runtime;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use cafofo_audio_engine::AudioDeviceInfo;
use cafofo_game_detector::{ActiveGameSession, DetectedProcess, KnownGameEntry};
use cafofo_screen_capture::{extract_exe_icon_data_url, WindowInfo};
use runtime::{AudioStatus, CafofoRuntime};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

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

fn show_and_focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
    let allow_exit = Arc::new(AtomicBool::new(false));
    let allow_exit_for_tray = Arc::clone(&allow_exit);
    let allow_exit_for_window = Arc::clone(&allow_exit);
    let launched_from_autostart = std::env::args().any(|arg| arg == "--autostart");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_and_focus_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(runtime)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("cafofo"));
            let custom_games_file = app_data_dir.join("custom_games.json");

            // Habilita inicialização com o sistema na primeira abertura (respeitando escolha futura do usuário)
            let autostart_marker = app_data_dir.join(".autostart_initialized");
            if !autostart_marker.exists() {
                if let Err(err) = app.autolaunch().enable() {
                    tracing::warn!("não foi possível ativar autostart padrão: {err}");
                } else {
                    let _ = std::fs::create_dir_all(&app_data_dir);
                    let _ = std::fs::write(&autostart_marker, b"1");
                }
            }

            // Configura ícone e menu na bandeja do sistema (estilo Discord)
            let open_item = MenuItem::with_id(app, "open", "Abrir Cafofo", true, None::<&str>)?;
            let update_item = MenuItem::with_id(
                app,
                "check-updates",
                "Verificar atualizações",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Sair do Cafofo", true, None::<&str>)?;
            let tray_menu =
                Menu::with_items(app, &[&open_item, &update_item, &separator, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("cafofo-tray")
                .menu(&tray_menu)
                .tooltip("Cafofo")
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_and_focus_main_window(app),
                    "check-updates" => {
                        show_and_focus_main_window(app);
                        let _ = app.emit("cafofo://check-updates", ());
                    }
                    "quit" => {
                        allow_exit_for_tray.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_and_focus_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            let _tray = tray_builder.build(app)?;

            // Se não iniciou junto com o Windows, exibe a janela normalmente
            if !launched_from_autostart {
                show_and_focus_main_window(&app_handle);
            }

            tauri::async_runtime::spawn(async move {
                runtime_for_setup
                    .init_game_detector(app_handle, custom_games_file)
                    .await;
            });

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !allow_exit_for_window.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
