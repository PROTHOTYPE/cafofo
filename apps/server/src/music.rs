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
use tokio::sync::{watch, Mutex, Semaphore};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::state::AppState;

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

#[derive(Debug, Clone)]
struct CachedAudioFile {
    path: PathBuf,
    content_type: &'static str,
}

type InFlightDownloadRx = watch::Receiver<Option<Result<CachedAudioFile, String>>>;

#[derive(Debug, Clone)]
pub struct MusicHub {
    in_flight_downloads: Arc<Mutex<HashMap<String, InFlightDownloadRx>>>,
    download_semaphore: Arc<Semaphore>,
}

impl Default for MusicHub {
    fn default() -> Self {
        Self {
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
    pub token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    error: String,
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
    Query(query): Query<StreamQuery>,
    State(state): State<AppState>,
) -> Response {
    let header_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .and_then(|raw| {
            raw.strip_prefix("Bearer ")
                .or_else(|| raw.strip_prefix("bearer "))
        })
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let query_token = query
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let Some(token) = header_token.or(query_token) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                error: "Autenticação obrigatória para reproduzir áudio.".to_string(),
            }),
        )
            .into_response();
    };

    if let Err(err) = state.auth.verify_bearer_token(token).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                error: format!("Token inválido: {err}"),
            }),
        )
            .into_response();
    }

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
            .header(header::CACHE_CONTROL, "private, max-age=900")
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
        .header(header::CACHE_CONTROL, "private, max-age=900")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Length, Content-Range, Accept-Ranges",
        )
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
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
