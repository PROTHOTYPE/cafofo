mod auth;
mod music;
mod state;
mod ws;

use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, Method, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::auth::{LiveKitConfig, SupabaseAuth};
use crate::music::{prepare_music_handler, search_music_handler, stream_music_handler};
use crate::state::AppState;
use crate::ws::ws_handler;

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    active_rooms: usize,
    grace_period_ms: u64,
    supabase_auth_configured: bool,
    livekit_configured: bool,
}

async fn health_handler(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    let active_rooms = state.active_room_count().await;
    let grace_period_ms = u64::try_from(state.grace_period.as_millis()).unwrap_or(u64::MAX);
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            service: "cafofo-server",
            active_rooms,
            grace_period_ms,
            supabase_auth_configured: state.auth.is_configured(),
            livekit_configured: !state.livekit.api_key.is_empty()
                && !state.livekit.api_secret.is_empty(),
        }),
    )
}

#[tokio::main]
async fn main() {
    if dotenvy::from_path("../../.env").is_err() {
        let _ = dotenvy::dotenv();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("cafofo_server=info,tower_http=info")),
        )
        .init();

    let missing_vars: Vec<&'static str> = [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
    ]
    .into_iter()
    .filter(|key| std::env::var(key).map(|v| v.trim().is_empty()).unwrap_or(true))
    .collect();

    if !missing_vars.is_empty() {
        eprintln!(
            "AVISO: Variáveis obrigatórias ausentes ou vazias no .env: {}",
            missing_vars.join(", ")
        );
        tracing::warn!(
            missing = ?missing_vars,
            "missing or empty environment variables; WebSocket auth or LiveKit token issuance will reject requests until configured"
        );
    }

    let grace_period_ms = std::env::var("CAFOFO_GRACE_PERIOD_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(15_000);

    let bind_addr: SocketAddr = if let Ok(addr) = std::env::var("CAFOFO_SERVER_ADDR") {
        addr.parse().expect("invalid CAFOFO_SERVER_ADDR")
    } else {
        let raw_host = std::env::var("CAFOFO_HOST")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "0.0.0.0".to_string());
        let host = if raw_host.eq_ignore_ascii_case("localhost") {
            "127.0.0.1".to_string()
        } else {
            raw_host
        };
        let port = std::env::var("CAFOFO_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(3001);
        format!("{host}:{port}")
            .parse()
            .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], port)))
    };

    let auth = SupabaseAuth::from_env();
    let livekit = LiveKitConfig {
        url: std::env::var("LIVEKIT_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "ws://127.0.0.1:7880".to_string()),
        api_key: std::env::var("LIVEKIT_API_KEY")
            .ok()
            .map(|v| v.trim().to_string())
            .unwrap_or_default(),
        api_secret: std::env::var("LIVEKIT_API_SECRET")
            .ok()
            .map(|v| v.trim().to_string())
            .unwrap_or_default(),
    };

    let app_state = AppState::new(Duration::from_millis(grace_period_ms), auth, livekit);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/ws", get(ws_handler))
        .route("/api/music/search", get(search_music_handler))
        .route("/api/music/prepare/:video_id", post(prepare_music_handler))
        .route("/api/music/stream/:video_id", get(stream_music_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([
                    header::AUTHORIZATION,
                    header::CONTENT_TYPE,
                    header::RANGE,
                ])
                .expose_headers([
                    header::CONTENT_LENGTH,
                    header::CONTENT_RANGE,
                    header::ACCEPT_RANGES,
                ]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .expect("failed to bind TCP listener");

    println!("Cafofo signaling server listening on http://{bind_addr}");
    tracing::info!(%bind_addr, grace_period_ms, "Cafofo signaling server listening on http://{bind_addr}");

    axum::serve(listener, app)
        .await
        .expect("axum server terminated unexpectedly");
}
