use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::process::Command;
use tokio::sync::{watch, Mutex, RwLock, Semaphore};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::state::AppState;

const MAX_QUEUE_LEN: usize = 50;
const MUSIC_CACHE_DIR: &str = "/tmp/cafofo-music";
const YTDLP_CACHE_DIR: &str = "/tmp/yt-dlp-cache";
const MAX_CACHED_AUDIO_FILES: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MusicSearchResult {
    pub video_id: String,
    pub title: String,
    pub author: String,
    pub duration_sec: u64,
    pub thumbnail_url: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MusicTrack {
    pub track_uid: String,
    pub video_id: String,
    pub title: String,
    pub author: String,
    pub duration_sec: u64,
    pub thumbnail_url: String,
    pub url: String,
    pub requested_by_id: String,
    pub requested_by_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MusicRoomSnapshot {
    pub room_id: String,
    pub current: Option<MusicTrack>,
    pub queue: Vec<MusicTrack>,
    pub is_playing: bool,
    pub started_at_ms: u64,
    pub paused_offset_sec: f64,
    pub server_now_ms: u64,
    pub version: u64,
}

#[derive(Debug, Clone)]
struct MusicRoomState {
    current: Option<MusicTrack>,
    queue: Vec<MusicTrack>,
    is_playing: bool,
    started_at_ms: u64,
    paused_offset_sec: f64,
    version: u64,
}

impl Default for MusicRoomState {
    fn default() -> Self {
        Self {
            current: None,
            queue: Vec::new(),
            is_playing: false,
            started_at_ms: 0,
            paused_offset_sec: 0.0,
            version: 1,
        }
    }
}

impl MusicRoomState {
    fn advance_if_finished(&mut self, now_ms: u64) {
        while self.is_playing {
            let Some(cur) = self.current.as_ref() else {
                self.is_playing = false;
                break;
            };
            if cur.duration_sec == 0 {
                break;
            }
            let elapsed_sec = now_ms.saturating_sub(self.started_at_ms) as f64 / 1000.0;
            if elapsed_sec < (cur.duration_sec as f64) + 2.0 {
                break;
            }
            // Track finished naturally; move to next in queue
            if let Some(next) = self.queue.first().cloned() {
                let overflow_ms = ((elapsed_sec - cur.duration_sec as f64).max(0.0) * 1000.0) as u64;
                self.queue.remove(0);
                self.current = Some(next);
                self.started_at_ms = now_ms.saturating_sub(overflow_ms.min(2000));
                self.paused_offset_sec = 0.0;
                self.version += 1;
            } else {
                self.current = None;
                self.is_playing = false;
                self.started_at_ms = 0;
                self.paused_offset_sec = 0.0;
                self.version += 1;
                break;
            }
        }
    }

    fn to_snapshot(&self, room_id: &str, now_ms: u64) -> MusicRoomSnapshot {
        MusicRoomSnapshot {
            room_id: room_id.to_string(),
            current: self.current.clone(),
            queue: self.queue.clone(),
            is_playing: self.is_playing,
            started_at_ms: self.started_at_ms,
            paused_offset_sec: self.paused_offset_sec,
            server_now_ms: now_ms,
            version: self.version,
        }
    }
}

#[derive(Debug, Clone)]
struct CachedAudioFile {
    path: PathBuf,
    content_type: &'static str,
}

type InFlightDownloadRx = watch::Receiver<Option<Result<CachedAudioFile, String>>>;

#[derive(Debug, Clone)]
pub struct MusicHub {
    rooms: Arc<RwLock<HashMap<String, MusicRoomState>>>,
    in_flight_downloads: Arc<Mutex<HashMap<String, InFlightDownloadRx>>>,
    download_semaphore: Arc<Semaphore>,
}

impl Default for MusicHub {
    fn default() -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            in_flight_downloads: Arc::new(Mutex::new(HashMap::new())),
            download_semaphore: Arc::new(Semaphore::new(2)),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PrepareQuery {
    pub wait: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    pub start: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct EnqueueRequest {
    pub video_id: String,
    pub title: String,
    pub author: String,
    pub duration_sec: u64,
    pub thumbnail_url: String,
    pub url: String,
    pub requested_by_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RemoveRequest {
    pub track_uid: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    error: String,
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_valid_room_id(room_id: &str) -> bool {
    let t = room_id.trim();
    !t.is_empty()
        && t.len() <= 128
        && t == room_id
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
}

fn is_valid_video_id(video_id: &str) -> bool {
    video_id.len() == 11
        && video_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn extract_youtube_video_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if is_valid_video_id(trimmed) {
        return Some(trimmed.to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }

    // youtu.be/<id>
    if let Some(pos) = lower.find("youtu.be/") {
        let rest = &trimmed[pos + "youtu.be/".len()..];
        let candidate: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .collect();
        if is_valid_video_id(&candidate) {
            return Some(candidate);
        }
    }

    // youtube.com/watch?v=<id> or music.youtube.com/watch?v=<id>
    if let Some(pos) = lower.find("v=") {
        let rest = &trimmed[pos + 2..];
        let candidate: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .collect();
        if is_valid_video_id(&candidate) {
            return Some(candidate);
        }
    }

    // youtube.com/shorts/<id> or /embed/<id>
    for marker in ["shorts/", "embed/"] {
        if let Some(pos) = lower.find(marker) {
            let rest = &trimmed[pos + marker.len()..];
            let candidate: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                .collect();
            if is_valid_video_id(&candidate) {
                return Some(candidate);
            }
        }
    }

    None
}

async fn authenticate_request(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<String, (StatusCode, Json<ErrorBody>)> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody {
                    error: "Authorization Bearer token obrigatório.".to_string(),
                }),
            )
        })?;

    let authed = state.auth.verify_bearer_token(token).await.map_err(|err| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                error: format!("Token inválido: {err}"),
            }),
        )
    })?;
    Ok(authed.user_id)
}

fn parse_ytdlp_json_line(line: &str) -> Option<MusicSearchResult> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let video_id = v.get("id")?.as_str()?.trim().to_string();
    if !is_valid_video_id(&video_id) {
        return None;
    }
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("Faixa do YouTube")
        .trim()
        .to_string();
    let author = v
        .get("uploader")
        .or_else(|| v.get("channel"))
        .or_else(|| v.get("artist"))
        .and_then(|x| x.as_str())
        .unwrap_or("YouTube")
        .trim()
        .to_string();
    let duration_sec = v
        .get("duration")
        .and_then(|x| x.as_f64())
        .map(|d| d.max(0.0).round() as u64)
        .unwrap_or(0);
    let thumbnail_url = v
        .get("thumbnail")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .or_else(|| {
            v.get("thumbnails")
                .and_then(|arr| arr.as_array())
                .and_then(|arr| arr.last())
                .and_then(|obj| obj.get("url"))
                .and_then(|u| u.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"));

    Some(MusicSearchResult {
        url: format!("https://www.youtube.com/watch?v={video_id}"),
        video_id,
        title,
        author,
        duration_sec,
        thumbnail_url,
    })
}

pub async fn search_music_handler(
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<MusicSearchResult>>, (StatusCode, Json<ErrorBody>)> {
    let _user_id = authenticate_request(&headers, &state).await?;
    let clean_q = query.q.trim();
    if clean_q.is_empty() || clean_q.len() > 240 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "Informe o nome de uma música ou um link do YouTube.".to_string(),
            }),
        ));
    }

    if let Some(video_id) = extract_youtube_video_id(clean_q) {
        let watch_url = format!("https://www.youtube.com/watch?v={video_id}");
        let output = tokio::time::timeout(
            Duration::from_secs(12),
            Command::new("yt-dlp")
                .args([
                    "--no-playlist",
                    "--dump-single-json",
                    "--skip-download",
                    "--no-warnings",
                    "--extractor-args",
                    "youtube:player_client=android,tv_embedded,web",
                    &watch_url,
                ])
                .output(),
        )
        .await;

        if let Ok(Ok(out)) = output {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if let Some(parsed) = parse_ytdlp_json_line(stdout.trim()) {
                    return Ok(Json(vec![parsed]));
                }
            }
        }

        // Fast oEmbed fallback if yt-dlp metadata timed out
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
            .unwrap_or_default();
        if let Ok(resp) = client
            .get(format!(
                "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
            ))
            .send()
            .await
        {
            if let Ok(val) = resp.json::<serde_json::Value>().await {
                let title = val
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Vídeo do YouTube")
                    .to_string();
                let author = val
                    .get("author_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("YouTube")
                    .to_string();
                return Ok(Json(vec![MusicSearchResult {
                    thumbnail_url: format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"),
                    url: watch_url,
                    video_id,
                    title,
                    author,
                    duration_sec: 0,
                }]));
            }
        }

        return Ok(Json(vec![MusicSearchResult {
            thumbnail_url: format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"),
            url: watch_url,
            video_id: video_id.clone(),
            title: format!("YouTube ({video_id})"),
            author: "YouTube".to_string(),
            duration_sec: 0,
        }]));
    }

    let search_arg = format!("ytsearch5:{clean_q}");
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new("yt-dlp")
            .args([
                "--flat-playlist",
                "--dump-json",
                "--skip-download",
                "--no-warnings",
                &search_arg,
            ])
            .output(),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            Json(ErrorBody {
                error: "Busca no YouTube excedeu o tempo limite.".to_string(),
            }),
        )
    })?
    .map_err(|err| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: format!("Erro ao executar yt-dlp: {err}"),
            }),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!(%stderr, "yt-dlp search failed");
        return Err((
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody {
                error: "Não foi possível buscar no YouTube agora. Tente colar o link direto.".to_string(),
            }),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let results: Vec<MusicSearchResult> = stdout
        .lines()
        .filter_map(parse_ytdlp_json_line)
        .take(5)
        .collect();

    Ok(Json(results))
}

fn content_type_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "m4a" | "mp4" => "audio/mp4",
        "webm" => "audio/webm",
        "mp3" => "audio/mpeg",
        "ogg" | "opus" => "audio/ogg",
        _ => "audio/mp4",
    }
}

async fn find_cached_audio_file(video_id: &str) -> Option<CachedAudioFile> {
    for ext in ["m4a", "mp4", "webm", "mp3", "ogg"] {
        let candidate = PathBuf::from(MUSIC_CACHE_DIR).join(format!("{video_id}.{ext}"));
        if let Ok(meta) = tokio::fs::metadata(&candidate).await {
            if meta.len() > 4096 {
                return Some(CachedAudioFile {
                    path: candidate,
                    content_type: content_type_for_ext(ext),
                });
            }
        }
    }
    None
}

async fn prune_music_cache_if_needed() {
    let Ok(mut rd) = tokio::fs::read_dir(MUSIC_CACHE_DIR).await else {
        return;
    };
    let mut entries: Vec<(PathBuf, SystemTime)> = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let path = ent.path();
        let name = ent.file_name();
        let name_str = name.to_string_lossy();
        if name_str.contains(".part.") {
            continue;
        }
        if let Ok(meta) = ent.metadata().await {
            let modified = meta.modified().unwrap_or(UNIX_EPOCH);
            entries.push((path, modified));
        }
    }
    if entries.len() <= MAX_CACHED_AUDIO_FILES {
        return;
    }
    entries.sort_by_key(|(_, mtime)| *mtime);
    let remove_count = entries.len().saturating_sub(MAX_CACHED_AUDIO_FILES);
    for (path, _) in entries.into_iter().take(remove_count) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

async fn download_audio_to_cache(video_id: &str) -> Result<CachedAudioFile, String> {
    let _ = tokio::fs::create_dir_all(MUSIC_CACHE_DIR).await;
    let _ = tokio::fs::create_dir_all(YTDLP_CACHE_DIR).await;

    let unique = Uuid::new_v4().simple().to_string();
    let part_prefix = format!("{video_id}.part.{unique}.");
    let out_template = format!("{MUSIC_CACHE_DIR}/{part_prefix}%(ext)s");
    let watch_url = format!("https://www.youtube.com/watch?v={video_id}");

    // Baixa o áudio nativo (preferindo formato 140 m4a/AAC 128kbps compatível com 100% dos navegadores)
    // Usando .output() para drenar stdout/stderr completamente e jamais gerar SIGPIPE.
    let output = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new("yt-dlp")
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .args([
                "--no-playlist",
                "--no-warnings",
                "--no-progress",
                "--no-check-certificates",
                "--no-part",
                "--cache-dir",
                YTDLP_CACHE_DIR,
                "-f",
                "140/bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio[ext=webm]/bestaudio/best",
                "-o",
                &out_template,
                &watch_url,
            ])
            .output(),
    )
    .await
    .map_err(|_| "Timeout ao baixar áudio do YouTube (45s).".to_string())?
    .map_err(|err| format!("Falha ao executar yt-dlp: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp falhou: {}", stderr.trim()));
    }

    // Localiza o arquivo temporário baixado e renomeia atomicamente para o cache final
    let mut rd = tokio::fs::read_dir(MUSIC_CACHE_DIR)
        .await
        .map_err(|err| format!("Falha ao ler diretório de cache: {err}"))?;
    let mut downloaded_path: Option<PathBuf> = None;
    while let Ok(Some(ent)) = rd.next_entry().await {
        let fname = ent.file_name();
        if fname.to_string_lossy().starts_with(&part_prefix) {
            downloaded_path = Some(ent.path());
            break;
        }
    }

    let tmp_path = downloaded_path
        .ok_or_else(|| "yt-dlp concluiu mas o arquivo de áudio não foi encontrado.".to_string())?;
    let meta = tokio::fs::metadata(&tmp_path)
        .await
        .map_err(|err| format!("Falha ao verificar arquivo baixado: {err}"))?;
    if meta.len() <= 4096 {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err("Áudio baixado está vazio ou corrompido.".to_string());
    }

    let ext = FsPath::new(&tmp_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("m4a")
        .to_ascii_lowercase();
    let final_path = PathBuf::from(MUSIC_CACHE_DIR).join(format!("{video_id}.{ext}"));
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|err| format!("Falha ao finalizar arquivo em cache: {err}"))?;

    prune_music_cache_if_needed().await;

    Ok(CachedAudioFile {
        path: final_path,
        content_type: content_type_for_ext(&ext),
    })
}

async fn ensure_cached_audio_file(
    hub: &MusicHub,
    video_id: &str,
) -> Result<CachedAudioFile, String> {
    if let Some(existing) = find_cached_audio_file(video_id).await {
        return Ok(existing);
    }

    // Single-flight dedupe + tarefa desacoplada (tokio::spawn):
    // Mesmo que o request HTTP que disparou o download seja cancelado pelo cliente,
    // a tarefa conclui o download e limpa `in_flight_downloads` sem corromper o map.
    let mut rx = {
        let mut guard = hub.in_flight_downloads.lock().await;
        if let Some(existing_rx) = guard.get(video_id) {
            existing_rx.clone()
        } else {
            let (tx, rx) = watch::channel(None);
            guard.insert(video_id.to_string(), rx.clone());
            let hub_clone = hub.clone();
            let vid = video_id.to_string();
            tokio::spawn(async move {
                let _permit = hub_clone.download_semaphore.acquire().await;
                let result = match find_cached_audio_file(&vid).await {
                    Some(existing) => Ok(existing),
                    None => download_audio_to_cache(&vid).await,
                };
                let _ = tx.send(Some(result));
                let mut cleanup = hub_clone.in_flight_downloads.lock().await;
                cleanup.remove(&vid);
            });
            rx
        }
    };

    if rx.wait_for(|v| v.is_some()).await.is_ok() {
        if let Some(res) = rx.borrow().clone() {
            return res;
        }
    }

    if let Some(existing) = find_cached_audio_file(video_id).await {
        return Ok(existing);
    }

    Err("Download em andamento foi interrompido. Tente novamente.".to_string())
}

fn parse_byte_range(range_header: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }
    let spec = range_header.trim().strip_prefix("bytes=")?;
    let first_range = spec.split(',').next()?.trim();
    let (start_str, end_str) = first_range.split_once('-')?;

    if start_str.is_empty() {
        // Suffix range: bytes=-N
        let suffix: u64 = end_str.trim().parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix);
        return Some((start, total_len - 1));
    }

    let start: u64 = start_str.trim().parse().ok()?;
    if start >= total_len {
        return None;
    }

    let end = if end_str.trim().is_empty() {
        total_len - 1
    } else {
        end_str
            .trim()
            .parse::<u64>()
            .ok()?
            .min(total_len - 1)
    };

    if start > end {
        return None;
    }
    Some((start, end))
}

pub async fn prepare_music_handler(
    headers: HeaderMap,
    Path(video_id): Path<String>,
    Query(query): Query<PrepareQuery>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, Json<ErrorBody>)> {
    let _user_id = authenticate_request(&headers, &state).await?;
    if !is_valid_video_id(&video_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "video_id inválido.".to_string(),
            }),
        ));
    }

    let should_wait = matches!(
        query.wait.as_deref().map(str::trim),
        Some("1" | "true" | "TRUE")
    );

    if should_wait {
        ensure_cached_audio_file(&state.music, &video_id)
            .await
            .map_err(|err| {
                tracing::warn!(%video_id, %err, "synchronous music prepare failed");
                (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: err }))
            })?;
        return Ok(StatusCode::OK);
    }

    let hub = state.music.clone();
    tokio::spawn(async move {
        if let Err(err) = ensure_cached_audio_file(&hub, &video_id).await {
            tracing::warn!(%video_id, %err, "background music pre-warm failed");
        }
    });

    Ok(StatusCode::ACCEPTED)
}

pub async fn stream_music_handler(
    headers: HeaderMap,
    Path(video_id): Path<String>,
    Query(_query): Query<StreamQuery>,
    State(state): State<AppState>,
) -> Response {
    if !is_valid_video_id(&video_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "video_id inválido.".to_string(),
            }),
        )
            .into_response();
    }

    let cached = match ensure_cached_audio_file(&state.music, &video_id).await {
        Ok(f) => f,
        Err(err) => {
            tracing::warn!(%video_id, %err, "failed to prepare cached YouTube audio");
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: err }),
            )
                .into_response();
        }
    };

    let mut file = match tokio::fs::File::open(&cached.path).await {
        Ok(f) => f,
        Err(err) => {
            tracing::warn!(%video_id, %err, "failed to open cached audio file");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: format!("Falha ao abrir áudio em cache: {err}"),
                }),
            )
                .into_response();
        }
    };

    let total_len = match file.metadata().await {
        Ok(m) => m.len(),
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: format!("Falha ao ler metadados do áudio: {err}"),
                }),
            )
                .into_response();
        }
    };

    if let Some(range_raw) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let Some((start, end)) = parse_byte_range(range_raw, total_len) else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total_len}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::RANGE_NOT_SATISFIABLE.into_response());
        };

        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let chunk_len = end - start + 1;
        let limited = file.take(chunk_len);
        let stream = ReaderStream::new(limited);

        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, cached.content_type)
            .header(header::CONTENT_LENGTH, chunk_len.to_string())
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total_len}"),
            )
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "public, max-age=900")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Content-Length, Content-Range, Accept-Ranges",
            )
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    let stream = ReaderStream::new(file);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, cached.content_type)
        .header(header::CONTENT_LENGTH, total_len.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=900")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Length, Content-Range, Accept-Ranges",
        )
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub async fn get_room_music_handler(
    headers: HeaderMap,
    Path(room_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MusicRoomSnapshot>, (StatusCode, Json<ErrorBody>)> {
    let _user_id = authenticate_request(&headers, &state).await?;
    if !is_valid_room_id(&room_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "room_id inválido.".to_string(),
            }),
        ));
    }

    let now = now_epoch_ms();
    let mut rooms = state.music.rooms.write().await;
    let room = rooms.entry(room_id.clone()).or_default();
    room.advance_if_finished(now);
    Ok(Json(room.to_snapshot(&room_id, now)))
}

pub async fn enqueue_music_handler(
    headers: HeaderMap,
    Path(room_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<EnqueueRequest>,
) -> Result<Json<MusicRoomSnapshot>, (StatusCode, Json<ErrorBody>)> {
    let user_id = authenticate_request(&headers, &state).await?;
    if !is_valid_room_id(&room_id) || !is_valid_video_id(&body.video_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "Parâmetros inválidos para adicionar música.".to_string(),
            }),
        ));
    }

    let track = MusicTrack {
        track_uid: Uuid::new_v4().to_string(),
        video_id: body.video_id.clone(),
        title: body.title.trim().chars().take(160).collect(),
        author: body.author.trim().chars().take(80).collect(),
        duration_sec: body.duration_sec,
        thumbnail_url: body.thumbnail_url.trim().to_string(),
        url: body.url.trim().to_string(),
        requested_by_id: user_id,
        requested_by_name: body
            .requested_by_name
            .unwrap_or_else(|| "Membro".to_string())
            .trim()
            .chars()
            .take(48)
            .collect(),
    };

    let now = now_epoch_ms();
    let mut rooms = state.music.rooms.write().await;
    let room = rooms.entry(room_id.clone()).or_default();
    room.advance_if_finished(now);

    if room.current.is_none() {
        room.current = Some(track);
        room.is_playing = true;
        room.started_at_ms = now;
        room.paused_offset_sec = 0.0;
    } else {
        if room.queue.len() >= MAX_QUEUE_LEN {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: format!("Fila cheia (máximo de {MAX_QUEUE_LEN} músicas)."),
                }),
            ));
        }
        room.queue.push(track);
    }
    room.version += 1;

    // Pre-warm audio cache in background so playback starts instantaneously
    let hub_clone = state.music.clone();
    let vid_clone = body.video_id;
    tokio::spawn(async move {
        let _ = ensure_cached_audio_file(&hub_clone, &vid_clone).await;
    });

    Ok(Json(room.to_snapshot(&room_id, now)))
}

pub async fn toggle_music_handler(
    headers: HeaderMap,
    Path(room_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MusicRoomSnapshot>, (StatusCode, Json<ErrorBody>)> {
    let _user_id = authenticate_request(&headers, &state).await?;
    if !is_valid_room_id(&room_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "room_id inválido.".to_string(),
            }),
        ));
    }

    let now = now_epoch_ms();
    let mut rooms = state.music.rooms.write().await;
    let room = rooms.entry(room_id.clone()).or_default();
    room.advance_if_finished(now);

    if room.current.is_some() {
        if room.is_playing {
            let elapsed = now.saturating_sub(room.started_at_ms) as f64 / 1000.0;
            room.paused_offset_sec = elapsed.max(0.0);
            room.is_playing = false;
        } else {
            let offset_ms = (room.paused_offset_sec.max(0.0) * 1000.0) as u64;
            room.started_at_ms = now.saturating_sub(offset_ms);
            room.is_playing = true;
        }
        room.version += 1;
    }

    Ok(Json(room.to_snapshot(&room_id, now)))
}

pub async fn skip_music_handler(
    headers: HeaderMap,
    Path(room_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MusicRoomSnapshot>, (StatusCode, Json<ErrorBody>)> {
    let _user_id = authenticate_request(&headers, &state).await?;
    if !is_valid_room_id(&room_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "room_id inválido.".to_string(),
            }),
        ));
    }

    let now = now_epoch_ms();
    let mut rooms = state.music.rooms.write().await;
    let room = rooms.entry(room_id.clone()).or_default();

    if let Some(next) = room.queue.first().cloned() {
        room.queue.remove(0);
        room.current = Some(next);
        room.is_playing = true;
        room.started_at_ms = now;
        room.paused_offset_sec = 0.0;
    } else {
        room.current = None;
        room.is_playing = false;
        room.started_at_ms = 0;
        room.paused_offset_sec = 0.0;
    }
    room.version += 1;

    Ok(Json(room.to_snapshot(&room_id, now)))
}

pub async fn remove_music_handler(
    headers: HeaderMap,
    Path(room_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<RemoveRequest>,
) -> Result<Json<MusicRoomSnapshot>, (StatusCode, Json<ErrorBody>)> {
    let _user_id = authenticate_request(&headers, &state).await?;
    if !is_valid_room_id(&room_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "room_id inválido.".to_string(),
            }),
        ));
    }

    let now = now_epoch_ms();
    let mut rooms = state.music.rooms.write().await;
    let room = rooms.entry(room_id.clone()).or_default();
    room.advance_if_finished(now);

    let before = room.queue.len();
    room.queue.retain(|t| t.track_uid != body.track_uid);
    if room.queue.len() != before {
        room.version += 1;
    }

    Ok(Json(room.to_snapshot(&room_id, now)))
}

pub async fn clear_music_handler(
    headers: HeaderMap,
    Path(room_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MusicRoomSnapshot>, (StatusCode, Json<ErrorBody>)> {
    let _user_id = authenticate_request(&headers, &state).await?;
    if !is_valid_room_id(&room_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "room_id inválido.".to_string(),
            }),
        ));
    }

    let now = now_epoch_ms();
    let mut rooms = state.music.rooms.write().await;
    let room = rooms.entry(room_id.clone()).or_default();
    room.current = None;
    room.queue.clear();
    room.is_playing = false;
    room.started_at_ms = 0;
    room.paused_offset_sec = 0.0;
    room.version += 1;

    Ok(Json(room.to_snapshot(&room_id, now)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_byte_range("bytes=0-1023", 500), Some((0, 499)));
        assert_eq!(parse_byte_range("bytes=100-199", 1000), Some((100, 199)));
        assert_eq!(parse_byte_range("bytes=-250", 1000), Some((750, 999)));
        assert_eq!(parse_byte_range("bytes=1000-", 1000), None);
        assert_eq!(parse_byte_range("bytes=500-400", 1000), None);
    }

    #[test]
    fn extracts_youtube_video_ids() {
        assert_eq!(
            extract_youtube_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            extract_youtube_video_id("https://youtu.be/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(extract_youtube_video_id("hungria provavelmente"), None);
    }
}
