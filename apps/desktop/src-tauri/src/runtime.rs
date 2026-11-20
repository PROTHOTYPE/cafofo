use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use cafofo_audio_engine::{
    list_input_devices, AudioDeviceInfo, AudioMetrics, LoopbackMode, MicrophoneCapture,
    MicrophoneConfig, ProcessLoopbackCapture, ProcessLoopbackConfig, PushToTalkConfig,
    PushToTalkMonitor, DENOISE_FRAME_SIZE, TARGET_SAMPLE_RATE_HZ,
};
use cafofo_game_detector::{
    spawn_detection_loop, ActiveGameSession, DetectedProcess, GameDetector, KnownGameEntry,
};
use cafofo_protocol::GamePresenceUpdate;
use cafofo_screen_capture::{
    bgra_to_i420, enumerate_visible_windows, CaptureConfig, WgcWindowCapturer, WindowInfo,
};
use livekit::options::{AudioEncoding, TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use ringbuf::traits::{Consumer, Observer};
use rodio::{Decoder, OutputStream, Sink};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

const MAX_ENTRY_SOUND_DOWNLOAD_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioStatus {
    pub connected: bool,
    pub muted: bool,
    pub deafened: bool,
    pub rnnoise_enabled: bool,
    pub ptt_key: Option<u16>,
    pub ptt_active: bool,
    pub rms_level: f32,
    pub vad_probability: f32,
    pub sharing_window_hwnd: Option<isize>,
    pub loopback_mode: Option<LoopbackMode>,
}

struct ActiveMicPipeline {
    stop_flag: Arc<AtomicBool>,
    thread_handle: Option<thread::JoinHandle<()>>,
    pump_task: JoinHandle<()>,
    metrics: Arc<AudioMetrics>,
}

impl ActiveMicPipeline {
    fn stop(mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        self.pump_task.abort();
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}

struct ActiveScreenShare {
    hwnd: isize,
    loopback_mode: Option<LoopbackMode>,
    video_track_sid: TrackSid,
    audio_track_sid: Option<TrackSid>,
    stop_flag: Arc<AtomicBool>,
    video_thread: Option<thread::JoinHandle<()>>,
    audio_thread: Option<thread::JoinHandle<()>>,
    video_pump_task: JoinHandle<()>,
    audio_pump_task: Option<JoinHandle<()>>,
}

impl ActiveScreenShare {
    async fn stop(mut self, room: &Room) {
        self.stop_flag.store(true, Ordering::Relaxed);
        self.video_pump_task.abort();
        if let Some(task) = self.audio_pump_task.take() {
            task.abort();
        }
        if let Some(handle) = self.video_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.audio_thread.take() {
            let _ = handle.join();
        }

        let local = room.local_participant();
        let _ = local.unpublish_track(&self.video_track_sid).await;
        if let Some(audio_sid) = self.audio_track_sid {
            let _ = local.unpublish_track(&audio_sid).await;
        }
    }
}

struct VoiceRoomSession {
    room: Arc<Room>,
    events_task: JoinHandle<()>,
    mic_track_sid: TrackSid,
    mic_pipeline: ActiveMicPipeline,
    screen_share: Option<ActiveScreenShare>,
}

pub struct CafofoRuntime {
    muted: Arc<AtomicBool>,
    deafened: Arc<AtomicBool>,
    rnnoise_enabled: Arc<AtomicBool>,
    ptt: Arc<PushToTalkMonitor>,
    session: Mutex<Option<VoiceRoomSession>>,
    detector: Arc<Mutex<GameDetector>>,
    detection_task: Mutex<Option<JoinHandle<()>>>,
    custom_games_path: Mutex<Option<PathBuf>>,
    http_client: reqwest::Client,
}

impl Default for CafofoRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl CafofoRuntime {
    pub fn new() -> Self {
        Self {
            muted: Arc::new(AtomicBool::new(false)),
            deafened: Arc::new(AtomicBool::new(false)),
            rnnoise_enabled: Arc::new(AtomicBool::new(true)),
            ptt: Arc::new(PushToTalkMonitor::start(PushToTalkConfig::default())),
            session: Mutex::new(None),
            detector: Arc::new(Mutex::new(GameDetector::default())),
            detection_task: Mutex::new(None),
            custom_games_path: Mutex::new(None),
            http_client: reqwest::Client::builder()
                .timeout(Duration::from_secs(6))
                .build()
                .expect("failed to build reqwest client"),
        }
    }

    pub async fn init_game_detector(&self, app: AppHandle, custom_games_file: PathBuf) {
        if let Ok(raw) = tokio::fs::read_to_string(&custom_games_file).await {
            if let Ok(entries) = serde_json::from_str::<Vec<KnownGameEntry>>(&raw) {
                let mut guard = self.detector.lock().await;
                guard.set_custom_games(entries);
            }
        }

        {
            let mut path_guard = self.custom_games_path.lock().await;
            *path_guard = Some(custom_games_file);
        }

        let mut task_guard = self.detection_task.lock().await;
        if task_guard.is_none() {
            let detector = Arc::clone(&self.detector);
            let handle = spawn_detection_loop(detector, Duration::from_secs(5), move |session| {
                let payload = session_to_presence(session);
                if let Err(err) = app.emit("game-presence-changed", &payload) {
                    tracing::warn!(%err, "failed to emit game-presence-changed event");
                }
            });
            *task_guard = Some(handle);
        }
    }

    pub async fn set_game_catalog(&self, app: AppHandle, entries: Vec<KnownGameEntry>) {
        let changed = {
            let mut guard = self.detector.lock().await;
            guard.update_catalog(entries);
            guard.poll_change()
        };
        if let Some(session) = changed {
            let _ = app.emit("game-presence-changed", session_to_presence(session));
        }
    }

    pub async fn sync_custom_games(
        &self,
        app: AppHandle,
        entries: Vec<KnownGameEntry>,
    ) -> Result<Vec<KnownGameEntry>, String> {
        let (updated, changed) = {
            let mut guard = self.detector.lock().await;
            let mut merged = guard.custom_games().to_vec();
            for mut incoming in entries {
                incoming.is_custom = true;
                if let Some(existing) = merged.iter_mut().find(|g| {
                    g.game_id == incoming.game_id
                        || g.executables.iter().any(|exe| {
                            incoming
                                .executables
                                .iter()
                                .any(|inc_exe| exe.eq_ignore_ascii_case(inc_exe))
                        })
                }) {
                    *existing = incoming;
                } else {
                    merged.push(incoming);
                }
            }
            guard.set_custom_games(merged);
            let list = guard.custom_games().to_vec();
            let changed = guard.poll_change();
            (list, changed)
        };

        self.persist_custom_games(&updated).await?;
        if let Some(session) = changed {
            let _ = app.emit("game-presence-changed", session_to_presence(session));
        }

        Ok(updated)
    }

    pub async fn list_custom_games(&self) -> Vec<KnownGameEntry> {
        let guard = self.detector.lock().await;
        guard.custom_games().to_vec()
    }

    pub async fn add_custom_game(
        &self,
        app: AppHandle,
        name: String,
        executable: String,
    ) -> Result<Vec<KnownGameEntry>, String> {
        let trimmed_name = name.trim();
        let trimmed_exe = executable.trim();
        if trimmed_name.is_empty() || trimmed_exe.is_empty() {
            return Err("Game name and executable are required".to_string());
        }

        let slug = trimmed_name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>();

        let entry = KnownGameEntry {
            game_id: format!("custom:{slug}"),
            name: trimmed_name.to_string(),
            executables: vec![trimmed_exe.to_string()],
            is_custom: true,
        };

        let (updated, changed) = {
            let mut guard = self.detector.lock().await;
            guard.add_custom_game(entry);
            let list = guard.custom_games().to_vec();
            let changed = guard.poll_change();
            (list, changed)
        };

        self.persist_custom_games(&updated).await?;
        if let Some(session) = changed {
            let _ = app.emit("game-presence-changed", session_to_presence(session));
        }

        Ok(updated)
    }

    pub async fn remove_custom_game(
        &self,
        app: AppHandle,
        game_id: String,
    ) -> Result<Vec<KnownGameEntry>, String> {
        let (updated, changed) = {
            let mut guard = self.detector.lock().await;
            guard.remove_custom_game(&game_id);
            let list = guard.custom_games().to_vec();
            let changed = guard.poll_change();
            (list, changed)
        };

        self.persist_custom_games(&updated).await?;
        if let Some(session) = changed {
            let _ = app.emit("game-presence-changed", session_to_presence(session));
        }

        Ok(updated)
    }

    pub async fn active_game_session(&self) -> Option<ActiveGameSession> {
        let guard = self.detector.lock().await;
        guard.current_session().cloned()
    }

    pub async fn list_running_processes(&self) -> Vec<DetectedProcess> {
        let mut guard = self.detector.lock().await;
        guard.list_processes()
    }

    async fn persist_custom_games(&self, entries: &[KnownGameEntry]) -> Result<(), String> {
        let path = {
            let guard = self.custom_games_path.lock().await;
            guard.clone()
        };
        let Some(file_path) = path else {
            return Ok(());
        };
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create custom games dir: {e}"))?;
        }
        let json = serde_json::to_string_pretty(entries)
            .map_err(|e| format!("failed to serialize custom games: {e}"))?;
        tokio::fs::write(&file_path, json)
            .await
            .map_err(|e| format!("failed to write custom games: {e}"))?;
        Ok(())
    }

    pub async fn play_entry_sound(&self, url: String, volume: f32) -> Result<(), String> {
        if self.deafened.load(Ordering::Relaxed) {
            return Ok(());
        }
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Ok(());
        }

        let response = self
            .http_client
            .get(trimmed)
            .send()
            .await
            .map_err(|e| format!("failed to download entry sound: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "entry sound download returned HTTP {}",
                response.status()
            ));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("failed to read entry sound bytes: {e}"))?;

        if bytes.len() > MAX_ENTRY_SOUND_DOWNLOAD_BYTES {
            return Err("entry sound exceeds 1 MB playback limit".to_string());
        }

        let clamped_vol = volume.clamp(0.0, 2.0);
        let data = bytes.to_vec();

        thread::Builder::new()
            .name("cafofo-entry-sound".to_string())
            .spawn(move || {
                let Ok((_stream, stream_handle)) = OutputStream::try_default() else {
                    tracing::warn!("no audio output device available for entry sound");
                    return;
                };
                let Ok(sink) = Sink::try_new(&stream_handle) else {
                    return;
                };
                sink.set_volume(clamped_vol);

                let Ok(source) = Decoder::new(Cursor::new(data)) else {
                    tracing::warn!("failed to decode entry sound audio");
                    return;
                };

                sink.append(source);
                sink.sleep_until_end();
            })
            .map_err(|e| format!("failed to spawn audio playback thread: {e}"))?;

        Ok(())
    }

    pub fn list_audio_inputs(&self) -> Result<Vec<AudioDeviceInfo>, String> {
        list_input_devices().map_err(|e| e.to_string())
    }

    pub fn list_windows(&self) -> Result<Vec<WindowInfo>, String> {
        enumerate_visible_windows().map_err(|e| e.to_string())
    }

    pub async fn join_voice_room(
        &self,
        url: String,
        token: String,
        mic_device_id: Option<String>,
    ) -> Result<(), String> {
        self.leave_voice_room().await?;

        let mut room_options = RoomOptions::default();
        room_options.auto_subscribe = true;
        room_options.dynacast = false;
        room_options.connect_timeout = Duration::from_secs(15);
        room_options.join_retries = 3;

        let (room, mut room_events) =
            connect_room_with_ipv4_fallback(&url, &token, room_options).await?;

        let room = Arc::new(room);
        let events_task = tokio::spawn(async move {
            while let Some(event) = room_events.recv().await {
                match event {
                    RoomEvent::Disconnected { reason } => {
                        tracing::info!(?reason, "disconnected from LiveKit room");
                        break;
                    }
                    RoomEvent::TrackSubscribed {
                        track, publication, ..
                    } => {
                        tracing::debug!(sid = %publication.sid(), ?track, "subscribed remote track");
                    }
                    _ => {}
                }
            }
        });

        let rnnoise_active = self.rnnoise_enabled.load(Ordering::Relaxed);
        let mic_source = NativeAudioSource::new(
            AudioSourceOptions {
                echo_cancellation: true,
                noise_suppression: false,
                auto_gain_control: !rnnoise_active,
            },
            TARGET_SAMPLE_RATE_HZ,
            1,
            100,
        );

        let mic_track = LocalAudioTrack::create_audio_track(
            "microphone",
            RtcAudioSource::Native(mic_source.clone()),
        );
        let mic_pub = room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(mic_track),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    dtx: true,
                    red: true,
                    audio_encoding: Some(AudioEncoding { max_bitrate: 32_000 }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| format!("failed to publish microphone track: {e}"))?;

        let mic_pipeline = self.spawn_mic_pipeline(mic_device_id, mic_source)?;

        let mut guard = self.session.lock().await;
        *guard = Some(VoiceRoomSession {
            room,
            events_task,
            mic_track_sid: mic_pub.sid(),
            mic_pipeline,
            screen_share: None,
        });

        Ok(())
    }

    pub async fn leave_voice_room(&self) -> Result<(), String> {
        let existing = {
            let mut guard = self.session.lock().await;
            guard.take()
        };

        let Some(mut session) = existing else {
            return Ok(());
        };

        if let Some(share) = session.screen_share.take() {
            share.stop(&session.room).await;
        }

        let _ = session
            .room
            .local_participant()
            .unpublish_track(&session.mic_track_sid)
            .await;

        session.mic_pipeline.stop();
        session.events_task.abort();
        let _ = session.room.close().await;
        Ok(())
    }

    pub fn set_voice_controls(
        &self,
        muted: Option<bool>,
        deafened: Option<bool>,
        rnnoise_enabled: Option<bool>,
    ) {
        if let Some(m) = muted {
            self.muted.store(m, Ordering::Relaxed);
        }
        if let Some(d) = deafened {
            self.deafened.store(d, Ordering::Relaxed);
            if d {
                self.muted.store(true, Ordering::Relaxed);
            }
        }
        if let Some(r) = rnnoise_enabled {
            self.rnnoise_enabled.store(r, Ordering::Relaxed);
        }
    }

    pub fn set_push_to_talk_key(&self, vk_code: Option<u16>) {
        self.ptt.set_key(vk_code);
    }

    pub async fn audio_status(&self) -> AudioStatus {
        let guard = self.session.lock().await;
        let (connected, rms_level, vad_probability, sharing_window_hwnd, loopback_mode) =
            match guard.as_ref() {
                Some(session) => (
                    true,
                    session.mic_pipeline.metrics.rms(),
                    session.mic_pipeline.metrics.vad(),
                    session.screen_share.as_ref().map(|s| s.hwnd),
                    session.screen_share.as_ref().and_then(|s| s.loopback_mode),
                ),
                None => (false, 0.0, 0.0, None, None),
            };

        AudioStatus {
            connected,
            muted: self.muted.load(Ordering::Relaxed),
            deafened: self.deafened.load(Ordering::Relaxed),
            rnnoise_enabled: self.rnnoise_enabled.load(Ordering::Relaxed),
            ptt_key: self.ptt.key(),
            ptt_active: self.ptt.is_pressed(),
            rms_level,
            vad_probability,
            sharing_window_hwnd,
            loopback_mode,
        }
    }

    pub async fn start_window_share(
        &self,
        hwnd: isize,
        pid: u32,
        target_fps: Option<u32>,
        share_audio: Option<bool>,
    ) -> Result<(), String> {
        let mut guard = self.session.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| "join a LiveKit voice room before starting screen share".to_string())?;

        if let Some(existing_share) = session.screen_share.take() {
            existing_share.stop(&session.room).await;
        }

        let fps = target_fps.unwrap_or(60).clamp(15, 60);
        let capture_audio = share_audio.unwrap_or(true);

        let video_source = NativeVideoSource::new(
            VideoResolution {
                width: 1920,
                height: 1080,
            },
            true,
        );

        let video_track = LocalVideoTrack::create_video_track(
            "screen-video",
            RtcVideoSource::Native(video_source.clone()),
        );
        let video_pub = session
            .room
            .local_participant()
            .publish_track(
                LocalTrack::Video(video_track),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    video_codec: VideoCodec::H264,
                    simulcast: false,
                    video_encoding: Some(VideoEncoding {
                        max_bitrate: 3_000_000,
                        max_framerate: f64::from(fps),
                    }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| format!("failed to publish screen video track: {e}"))?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let (frame_tx, mut frame_rx) = mpsc::channel(2);

        let (video_init_tx, video_init_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let video_stop = Arc::clone(&stop_flag);
        let video_thread = thread::Builder::new()
            .name("cafofo-wgc-pump".to_string())
            .spawn(move || {
                let mut handle = match WgcWindowCapturer::start_window(
                    hwnd,
                    CaptureConfig {
                        target_fps: fps,
                        capture_cursor: true,
                        draw_border: false,
                        capture_audio,
                    },
                ) {
                    Ok(h) => {
                        let _ = video_init_tx.send(Ok(()));
                        h
                    }
                    Err(err) => {
                        let _ = video_init_tx.send(Err(err.to_string()));
                        return;
                    }
                };

                while !video_stop.load(Ordering::Relaxed) {
                    match handle.frames.recv_timeout(Duration::from_millis(25)) {
                        Ok(frame) => {
                            let _ = frame_tx.try_send(frame);
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                handle.stop();
            })
            .map_err(|e| format!("failed to spawn WGC pump thread: {e}"))?;

        if let Err(err) = video_init_rx
            .recv()
            .map_err(|_| "WGC pump init channel closed".to_string())
            .and_then(|r| r)
        {
            stop_flag.store(true, Ordering::Relaxed);
            let _ = video_thread.join();
            let _ = session
                .room
                .local_participant()
                .unpublish_track(&video_pub.sid())
                .await;
            return Err(err);
        }

        let video_pump_task = tokio::spawn(async move {
            while let Some(frame) = frame_rx.recv().await {
                let (y, u, v) = bgra_to_i420(&frame.bgra, frame.width, frame.height);
                let mut i420 = I420Buffer::new(frame.width, frame.height);
                copy_i420_into_buffer(&mut i420, frame.width, frame.height, &y, &u, &v);

                video_source.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: (frame.timestamp_ms as i64) * 1000,
                    frame_metadata: None,
                    buffer: i420,
                });
            }
        });

        let mut audio_track_sid = None;
        let mut audio_thread = None;
        let mut audio_pump_task = None;
        let mut loopback_mode = None;

        if capture_audio && pid > 0 {
            let game_audio_source = NativeAudioSource::new(
                AudioSourceOptions {
                    echo_cancellation: false,
                    noise_suppression: false,
                    auto_gain_control: false,
                },
                TARGET_SAMPLE_RATE_HZ,
                2,
                200,
            );

            let audio_track = LocalAudioTrack::create_audio_track(
                "screen-audio",
                RtcAudioSource::Native(game_audio_source.clone()),
            );
            let audio_pub = session
                .room
                .local_participant()
                .publish_track(
                    LocalTrack::Audio(audio_track),
                    TrackPublishOptions {
                        source: TrackSource::ScreenshareAudio,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| format!("failed to publish screen audio track: {e}"))?;

            let (audio_init_tx, audio_init_rx) =
                std::sync::mpsc::channel::<Result<LoopbackMode, String>>();
            let (pcm_tx, mut pcm_rx) = mpsc::channel::<Vec<i16>>(16);
            let audio_stop = Arc::clone(&stop_flag);

            let thread_handle = thread::Builder::new()
                .name("cafofo-loopback-pump".to_string())
                .spawn(move || {
                    let mut capture = match ProcessLoopbackCapture::start(ProcessLoopbackConfig {
                        target_pid: pid,
                        allow_standard_fallback: true,
                    }) {
                        Ok(c) => {
                            let _ = audio_init_tx.send(Ok(c.mode));
                            c
                        }
                        Err(err) => {
                            let _ = audio_init_tx.send(Err(err.to_string()));
                            return;
                        }
                    };

                    const STEREO_10MS_SAMPLES: usize = DENOISE_FRAME_SIZE * 2;
                    let mut buf = vec![0i16; STEREO_10MS_SAMPLES];
                    while !audio_stop.load(Ordering::Relaxed) {
                        if capture.consumer.occupied_len() >= STEREO_10MS_SAMPLES {
                            let popped = capture.consumer.pop_slice(&mut buf);
                            if popped == STEREO_10MS_SAMPLES {
                                let _ = pcm_tx.try_send(buf.clone());
                            }
                        } else {
                            thread::sleep(Duration::from_millis(3));
                        }
                    }
                    capture.stop();
                })
                .map_err(|e| format!("failed to spawn loopback pump thread: {e}"))?;

            match audio_init_rx.recv() {
                Ok(Ok(mode)) => {
                    loopback_mode = Some(mode);
                    audio_track_sid = Some(audio_pub.sid());
                    audio_thread = Some(thread_handle);
                    audio_pump_task = Some(tokio::spawn(async move {
                        while let Some(pcm) = pcm_rx.recv().await {
                            let _ = game_audio_source
                                .capture_frame(&AudioFrame {
                                    data: pcm.into(),
                                    sample_rate: TARGET_SAMPLE_RATE_HZ,
                                    num_channels: 2,
                                    samples_per_channel: DENOISE_FRAME_SIZE as u32,
                                })
                                .await;
                        }
                    }));
                }
                Ok(Err(err)) => {
                    tracing::warn!(%err, "failed to start isolated process audio loopback");
                    let _ = thread_handle.join();
                    let _ = session
                        .room
                        .local_participant()
                        .unpublish_track(&audio_pub.sid())
                        .await;
                }
                Err(_) => {
                    let _ = thread_handle.join();
                }
            }
        }

        session.screen_share = Some(ActiveScreenShare {
            hwnd,
            loopback_mode,
            video_track_sid: video_pub.sid(),
            audio_track_sid,
            stop_flag,
            video_thread: Some(video_thread),
            audio_thread,
            video_pump_task,
            audio_pump_task,
        });

        Ok(())
    }

    pub async fn stop_window_share(&self) -> Result<(), String> {
        let mut guard = self.session.lock().await;
        let Some(session) = guard.as_mut() else {
            return Ok(());
        };

        if let Some(share) = session.screen_share.take() {
            share.stop(&session.room).await;
        }
        Ok(())
    }

    fn spawn_mic_pipeline(
        &self,
        mic_device_id: Option<String>,
        mic_source: NativeAudioSource,
    ) -> Result<ActiveMicPipeline, String> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop_flag);
        let muted = Arc::clone(&self.muted);
        let rnnoise_enabled = Arc::clone(&self.rnnoise_enabled);
        let ptt = Arc::clone(&self.ptt);

        let (pcm_tx, mut pcm_rx) = mpsc::channel::<Vec<i16>>(16);
        let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<Arc<AudioMetrics>, String>>();

        let thread_handle = thread::Builder::new()
            .name("cafofo-mic-pump".to_string())
            .spawn(move || {
                let mut capture = match MicrophoneCapture::start(MicrophoneConfig {
                    device_id: mic_device_id,
                    noise_suppression: rnnoise_enabled.load(Ordering::Relaxed),
                }) {
                    Ok(c) => {
                        let _ = init_tx.send(Ok(Arc::clone(&c.metrics)));
                        c
                    }
                    Err(err) => {
                        let _ = init_tx.send(Err(err.to_string()));
                        return;
                    }
                };

                let mut frame_buf = vec![0i16; DENOISE_FRAME_SIZE];
                let silence = vec![0i16; DENOISE_FRAME_SIZE];

                while !stop_clone.load(Ordering::Relaxed) {
                    let is_muted = muted.load(Ordering::Relaxed)
                        || (ptt.is_enabled() && !ptt.is_pressed());
                    capture.set_muted(is_muted);
                    capture.set_noise_suppression(rnnoise_enabled.load(Ordering::Relaxed));

                    if capture.consumer.occupied_len() >= DENOISE_FRAME_SIZE {
                        let popped = capture.consumer.pop_slice(&mut frame_buf);
                        if popped == DENOISE_FRAME_SIZE {
                            let payload = if is_muted {
                                silence.clone()
                            } else {
                                frame_buf.clone()
                            };
                            let _ = pcm_tx.try_send(payload);
                        }
                    } else {
                        thread::sleep(Duration::from_millis(3));
                    }
                }
            })
            .map_err(|e| format!("failed to spawn microphone pump thread: {e}"))?;

        let metrics = init_rx
            .recv()
            .map_err(|_| "microphone pump init channel closed".to_string())??;

        let pump_task = tokio::spawn(async move {
            while let Some(pcm) = pcm_rx.recv().await {
                let _ = mic_source
                    .capture_frame(&AudioFrame {
                        data: pcm.into(),
                        sample_rate: TARGET_SAMPLE_RATE_HZ,
                        num_channels: 1,
                        samples_per_channel: DENOISE_FRAME_SIZE as u32,
                    })
                    .await;
            }
        });

        Ok(ActiveMicPipeline {
            stop_flag,
            thread_handle: Some(thread_handle),
            pump_task,
            metrics,
        })
    }
}

fn session_to_presence(session: Option<ActiveGameSession>) -> GamePresenceUpdate {
    match session {
        Some(s) => GamePresenceUpdate {
            user_id: String::new(),
            game_id: Some(s.game_id),
            game_name: Some(s.game_name),
            process_name: Some(s.process_name),
            started_at_ms: Some(s.started_at_ms),
        },
        None => GamePresenceUpdate {
            user_id: String::new(),
            game_id: None,
            game_name: None,
            process_name: None,
            started_at_ms: None,
        },
    }
}

fn copy_i420_into_buffer(
    buffer: &mut I420Buffer,
    width: u32,
    height: u32,
    y_src: &[u8],
    u_src: &[u8],
    v_src: &[u8],
) {
    let w = width as usize;
    let h = height as usize;
    let cw = w.div_ceil(2);
    let ch = h.div_ceil(2);

    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (y_dst, u_dst, v_dst) = buffer.data_mut();

    for row in 0..h {
        let src_start = row * w;
        let dst_start = row * stride_y as usize;
        y_dst[dst_start..dst_start + w].copy_from_slice(&y_src[src_start..src_start + w]);
    }
    for row in 0..ch {
        let src_start = row * cw;
        let u_dst_start = row * stride_u as usize;
        let v_dst_start = row * stride_v as usize;
        u_dst[u_dst_start..u_dst_start + cw].copy_from_slice(&u_src[src_start..src_start + cw]);
        v_dst[v_dst_start..v_dst_start + cw].copy_from_slice(&v_src[src_start..src_start + cw]);
    }
}

fn ipv4_loopback_fallback_url(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let (authority, path_suffix) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };

    let (host, port_suffix) = if let Some(bracketed_end) = authority
        .strip_prefix('[')
        .and_then(|s| s.find(']'))
    {
        (&authority[..=bracketed_end + 1], &authority[bracketed_end + 2..])
    } else if let Some((h, _)) = authority.split_once(':') {
        (h, &authority[h.len()..])
    } else {
        (authority, "")
    };

    let clean = host.trim().trim_matches(['[', ']']);
    let is_local_or_private = clean.eq_ignore_ascii_case("localhost")
        || clean == "::1"
        || clean
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_private() || ip.is_link_local());

    if !is_local_or_private || clean == "127.0.0.1" {
        return None;
    }

    let effective_port = if port_suffix.is_empty() { ":7880" } else { port_suffix };
    Some(format!("{scheme}://127.0.0.1{effective_port}{path_suffix}"))
}

async fn connect_room_with_ipv4_fallback(
    url: &str,
    token: &str,
    options: RoomOptions,
) -> Result<(Room, tokio::sync::mpsc::UnboundedReceiver<RoomEvent>), String> {
    match Room::connect(url, token, options.clone()).await {
        Ok(connected) => Ok(connected),
        Err(first_err) => {
            if let Some(fallback_url) = ipv4_loopback_fallback_url(url) {
                tracing::warn!(
                    original_url = %url,
                    fallback_url = %fallback_url,
                    error = %first_err,
                    "LiveKit signal connect failed; retrying automatically via IPv4 127.0.0.1"
                );
                Room::connect(&fallback_url, token, options)
                    .await
                    .map_err(|retry_err| {
                        format!(
                            "failed to connect to LiveKit room ({first_err}); retry via {fallback_url} failed ({retry_err})"
                        )
                    })
            } else {
                Err(format!("failed to connect to LiveKit room: {first_err}"))
            }
        }
    }
}
