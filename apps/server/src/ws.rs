use std::collections::VecDeque;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use cafofo_protocol::{ErrorCode, ProtocolError, SignalMessage};
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::AuthenticatedUser;
use crate::state::{
    handle_unexpected_disconnect, issue_livekit_token, join_room, leave_room, move_peer_to_room,
    start_screen_share, stop_screen_share, update_game_presence, update_voice_state, ActiveSession,
    AppState,
};

const MAX_WS_TEXT_BYTES: usize = 16 * 1024;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const MAX_MESSAGES_PER_WINDOW: usize = 30;
const MAX_CONSECUTIVE_RATE_VIOLATIONS: u32 = 3;
const MAX_ID_LEN: usize = 128;
const MAX_DISPLAY_NAME_LEN: usize = 64;
const MAX_TITLE_LEN: usize = 128;
const MAX_FPS: u32 = 120;
const WS_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
enum RateLimitDecision {
    Allowed,
    Throttled { send_notice: bool },
    Disconnect,
}

#[derive(Debug)]
struct WsRateLimiter {
    window: Duration,
    max_messages: usize,
    timestamps: VecDeque<Instant>,
    last_violation_window_start: Option<Instant>,
    consecutive_violations: u32,
}

impl WsRateLimiter {
    fn new(max_messages: usize, window: Duration) -> Self {
        Self {
            window,
            max_messages,
            timestamps: VecDeque::with_capacity(max_messages),
            last_violation_window_start: None,
            consecutive_violations: 0,
        }
    }

    fn check(&mut self, now: Instant) -> RateLimitDecision {
        while let Some(&front) = self.timestamps.front() {
            if now.saturating_duration_since(front) >= self.window {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }

        if self.timestamps.len() < self.max_messages {
            self.timestamps.push_back(now);
            if let Some(last) = self.last_violation_window_start {
                if now.saturating_duration_since(last) >= self.window.saturating_mul(2) {
                    self.consecutive_violations = 0;
                    self.last_violation_window_start = None;
                }
            }
            return RateLimitDecision::Allowed;
        }

        let is_new_window = self
            .last_violation_window_start
            .map(|last| now.saturating_duration_since(last) >= self.window)
            .unwrap_or(true);

        if is_new_window {
            self.last_violation_window_start = Some(now);
            self.consecutive_violations = self.consecutive_violations.saturating_add(1);
        }

        if self.consecutive_violations > MAX_CONSECUTIVE_RATE_VIOLATIONS {
            RateLimitDecision::Disconnect
        } else {
            RateLimitDecision::Throttled {
                send_notice: is_new_window,
            }
        }
    }
}

fn validate_safe_id(value: &str, field: &str) -> Result<(), ProtocolError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ID_LEN {
        return Err(ProtocolError {
            code: ErrorCode::InvalidMessage,
            message: format!("{field} must be between 1 and {MAX_ID_LEN} characters"),
            recoverable: true,
        });
    }
    if trimmed != value
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
    {
        return Err(ProtocolError {
            code: ErrorCode::InvalidMessage,
            message: format!("{field} contains invalid characters"),
            recoverable: true,
        });
    }
    Ok(())
}

fn validate_display_text(
    value: &str,
    field: &str,
    max_len: usize,
    allow_empty: bool,
) -> Result<(), ProtocolError> {
    let trimmed = value.trim();
    if !allow_empty && trimmed.is_empty() {
        return Err(ProtocolError {
            code: ErrorCode::InvalidMessage,
            message: format!("{field} cannot be empty"),
            recoverable: true,
        });
    }
    if value.chars().count() > max_len || value.chars().any(char::is_control) {
        return Err(ProtocolError {
            code: ErrorCode::InvalidMessage,
            message: format!("{field} exceeds {max_len} chars or contains control characters"),
            recoverable: true,
        });
    }
    Ok(())
}

fn ensure_matching_user_id(provided: &str, expected: &str, context: &str) -> Result<(), ProtocolError> {
    if !provided.is_empty() && provided != expected {
        return Err(ProtocolError {
            code: ErrorCode::Unauthorized,
            message: format!("{context} user_id does not match authenticated user"),
            recoverable: false,
        });
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    State(state): State<AppState>,
) -> Response {
    let handshake_token = extract_bearer_token(&headers).or(query.token);
    let request_host = extract_request_hostname(&headers);
    let origin_host = extract_origin_hostname(&headers);

    let authenticated_user = match handshake_token.as_deref() {
        Some(token) => match state.auth.verify_bearer_token(token).await {
            Ok(user) => Some((user, token.to_string())),
            Err(err) => {
                tracing::warn!(%err, "rejected WebSocket upgrade with invalid bearer token");
                return (StatusCode::UNAUTHORIZED, "Invalid Supabase Auth token").into_response();
            }
        },
        None => None,
    };

    ws.on_upgrade(move |socket| {
        let (authed, bearer) = match authenticated_user {
            Some((u, tok)) => (Some(u), Some(tok)),
            None => (None, None),
        };
        handle_socket(socket, state, authed, bearer, request_host, origin_host)
    })
}

fn parse_authority_host(raw: &str) -> Option<String> {
    let clean = raw.trim();
    if clean.is_empty() {
        return None;
    }
    if let Some(rest) = clean.strip_prefix('[') {
        return rest
            .split(']')
            .next()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(str::to_string);
    }
    clean
        .split(':')
        .next()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(str::to_string)
}

fn extract_request_hostname(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::HOST)?.to_str().ok()?;
    parse_authority_host(raw)
}

fn extract_origin_hostname(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::ORIGIN)?.to_str().ok()?.trim();
    let without_scheme = raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw);
    let authority = without_scheme.split('/').next()?;
    parse_authority_host(authority)
}

fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    mut authenticated_user: Option<AuthenticatedUser>,
    mut bearer_token: Option<String>,
    request_host: Option<String>,
    origin_host: Option<String>,
) {
    let connection_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::unbounded_channel::<SignalMessage>();
    let mut active_session: Option<ActiveSession> = None;
    let mut rate_limiter = WsRateLimiter::new(MAX_MESSAGES_PER_WINDOW, RATE_LIMIT_WINDOW);
    let mut keepalive_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + WS_KEEPALIVE_INTERVAL,
        WS_KEEPALIVE_INTERVAL,
    );

    loop {
        tokio::select! {
            _ = keepalive_tick.tick() => {
                if let Err(err) = socket.send(Message::Ping(Vec::new())).await {
                    tracing::debug!(%connection_id, %err, "websocket keepalive ping failed");
                    break;
                }
            }
            Some(outgoing) = rx.recv() => {
                match serde_json::to_string(&outgoing) {
                    Ok(json) => {
                        if let Err(err) = socket.send(Message::Text(json)).await {
                            tracing::debug!(%connection_id, %err, "websocket write failed");
                            break;
                        }
                    }
                    Err(err) => {
                        tracing::error!(%connection_id, %err, "failed to serialize outgoing message");
                    }
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(raw))) => {
                        if raw.len() > MAX_WS_TEXT_BYTES {
                            let _ = tx.send(SignalMessage::Error(ProtocolError {
                                code: ErrorCode::InvalidMessage,
                                message: format!("signaling payload exceeds {MAX_WS_TEXT_BYTES} byte limit"),
                                recoverable: true,
                            }));
                            continue;
                        }

                        match rate_limiter.check(Instant::now()) {
                            RateLimitDecision::Allowed => {}
                            RateLimitDecision::Throttled { send_notice } => {
                                if send_notice {
                                    tracing::warn!(%connection_id, "WebSocket rate limit exceeded");
                                    let _ = tx.send(SignalMessage::Error(ProtocolError {
                                        code: ErrorCode::RateLimited,
                                        message: format!(
                                            "rate limit exceeded (max {MAX_MESSAGES_PER_WINDOW} messages per second)"
                                        ),
                                        recoverable: true,
                                    }));
                                }
                                continue;
                            }
                            RateLimitDecision::Disconnect => {
                                tracing::warn!(%connection_id, "disconnecting WebSocket after sustained flood");
                                let _ = tx.send(SignalMessage::Error(ProtocolError {
                                    code: ErrorCode::RateLimited,
                                    message: "disconnected due to sustained signaling flood".to_string(),
                                    recoverable: false,
                                }));
                                break;
                            }
                        }

                        let keep_open = handle_text_message(
                            &state,
                            connection_id,
                            &tx,
                            &mut authenticated_user,
                            &mut bearer_token,
                            &mut active_session,
                            request_host.as_deref(),
                            origin_host.as_deref(),
                            &raw,
                        ).await;
                        if !keep_open {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        tracing::debug!(%connection_id, %err, "websocket read error");
                        break;
                    }
                }
            }
        }
    }

    if let Some(session) = active_session {
        handle_unexpected_disconnect(state, session).await;
    }
}

async fn handle_text_message(
    state: &AppState,
    connection_id: Uuid,
    tx: &mpsc::UnboundedSender<SignalMessage>,
    authenticated_user: &mut Option<AuthenticatedUser>,
    bearer_token: &mut Option<String>,
    active_session: &mut Option<ActiveSession>,
    request_host: Option<&str>,
    origin_host: Option<&str>,
    raw: &str,
) -> bool {
    let parsed: SignalMessage = match serde_json::from_str(raw) {
        Ok(msg) => msg,
        Err(err) => {
            let _ = tx.send(SignalMessage::Error(ProtocolError {
                code: ErrorCode::InvalidMessage,
                message: format!("invalid signaling payload: {err}"),
                recoverable: true,
            }));
            return true;
        }
    };

    if let Err(err) = dispatch_client_message(
        state,
        connection_id,
        tx,
        authenticated_user,
        bearer_token,
        active_session,
        request_host,
        origin_host,
        parsed,
    )
    .await
    {
        let _ = tx.send(SignalMessage::Error(err));
    }

    true
}

async fn dispatch_client_message(
    state: &AppState,
    connection_id: Uuid,
    tx: &mpsc::UnboundedSender<SignalMessage>,
    authenticated_user: &mut Option<AuthenticatedUser>,
    bearer_token: &mut Option<String>,
    active_session: &mut Option<ActiveSession>,
    request_host: Option<&str>,
    origin_host: Option<&str>,
    parsed: SignalMessage,
) -> Result<(), ProtocolError> {
    match parsed {
        SignalMessage::JoinRoom(mut payload) => {
            if let Some(token) = payload.access_token.take() {
                match state.auth.verify_bearer_token(&token).await {
                    Ok(user) => {
                        *authenticated_user = Some(user);
                        *bearer_token = Some(token);
                    }
                    Err(err) => {
                        return Err(ProtocolError {
                            code: ErrorCode::Unauthorized,
                            message: format!("Supabase authentication failed: {err}"),
                            recoverable: false,
                        });
                    }
                }
            }

            let Some(authed) = authenticated_user.as_ref() else {
                return Err(ProtocolError {
                    code: ErrorCode::Unauthorized,
                    message: "missing Supabase Auth Bearer token on /ws or JoinRoom".to_string(),
                    recoverable: false,
                });
            };

            ensure_matching_user_id(&payload.user_id, &authed.user_id, "JoinRoom")?;
            validate_safe_id(&payload.room_id, "room_id")?;
            validate_display_text(
                &payload.display_name,
                "display_name",
                MAX_DISPLAY_NAME_LEN,
                false,
            )?;
            payload.user_id = authed.user_id.clone();

            let session = join_room(state, payload, connection_id, tx.clone()).await?;
            *active_session = Some(session);
            Ok(())
        }
        SignalMessage::RequestLiveKitToken(request) => match (authenticated_user.as_ref(), active_session.as_ref()) {
            (Some(_), Some(session)) => {
                if let Err(err) = validate_safe_id(&request.room_id, "room_id") {
                    Err(err)
                } else {
                    match issue_livekit_token(state, session, request, request_host, origin_host)
                        .await
                    {
                        Ok(issued) => {
                            let _ = tx.send(SignalMessage::LiveKitTokenIssued(issued));
                            Ok(())
                        }
                        Err(err) => Err(err),
                    }
                }
            }
            (None, _) => Err(ProtocolError {
                code: ErrorCode::Unauthorized,
                message: "authentication required before requesting a LiveKit token".to_string(),
                recoverable: false,
            }),
            (_, None) => Err(ProtocolError {
                code: ErrorCode::NotInRoom,
                message: "join a room before requesting a LiveKit token".to_string(),
                recoverable: true,
            }),
        },
        SignalMessage::LeaveRoom(mut payload) => match (authenticated_user.as_ref(), active_session.as_ref()) {
            (Some(authed), Some(session)) => {
                ensure_matching_user_id(&payload.user_id, &authed.user_id, "LeaveRoom")?;
                validate_safe_id(&payload.room_id, "room_id")?;
                if payload.room_id != session.room_id {
                    Err(ProtocolError {
                        code: ErrorCode::Unauthorized,
                        message: "cannot leave a room different from the active session".to_string(),
                        recoverable: false,
                    })
                } else {
                    payload.user_id = session.user_id.clone();
                    let res = leave_room(state, payload).await;
                    if res.is_ok() {
                        *active_session = None;
                    }
                    res
                }
            }
            (None, _) => Err(ProtocolError {
                code: ErrorCode::Unauthorized,
                message: "authentication required to leave a room".to_string(),
                recoverable: false,
            }),
            (_, None) => Err(ProtocolError {
                code: ErrorCode::NotInRoom,
                message: "not connected to any voice room".to_string(),
                recoverable: true,
            }),
        },
        SignalMessage::VoiceStateUpdate(mut payload) => match (authenticated_user.as_ref(), active_session.as_ref()) {
            (Some(authed), Some(session)) => {
                ensure_matching_user_id(&payload.user_id, &authed.user_id, "VoiceStateUpdate")?;
                validate_safe_id(&payload.room_id, "room_id")?;
                if payload.room_id != session.room_id {
                    Err(ProtocolError {
                        code: ErrorCode::Unauthorized,
                        message: "cannot update voice state for another room".to_string(),
                        recoverable: false,
                    })
                } else {
                    payload.user_id = session.user_id.clone();
                    update_voice_state(state, payload).await
                }
            }
            (None, _) => Err(ProtocolError {
                code: ErrorCode::Unauthorized,
                message: "authentication required to update voice state".to_string(),
                recoverable: false,
            }),
            (_, None) => Err(ProtocolError {
                code: ErrorCode::NotInRoom,
                message: "join a room before updating voice state".to_string(),
                recoverable: true,
            }),
        },
        SignalMessage::ScreenShareStarted(mut payload) => match (authenticated_user.as_ref(), active_session.as_ref()) {
            (Some(authed), Some(session)) => {
                ensure_matching_user_id(&payload.user_id, &authed.user_id, "ScreenShareStarted")?;
                validate_safe_id(&payload.room_id, "room_id")?;
                validate_safe_id(&payload.stream_id, "stream_id")?;
                validate_display_text(&payload.source_title, "source_title", MAX_TITLE_LEN, true)?;
                if payload.room_id != session.room_id {
                    Err(ProtocolError {
                        code: ErrorCode::Unauthorized,
                        message: "cannot broadcast screen share to another room".to_string(),
                        recoverable: false,
                    })
                } else if payload.fps == 0 || payload.fps > MAX_FPS {
                    Err(ProtocolError {
                        code: ErrorCode::InvalidMessage,
                        message: format!("fps must be between 1 and {MAX_FPS}"),
                        recoverable: true,
                    })
                } else {
                    payload.user_id = session.user_id.clone();
                    start_screen_share(state, payload).await
                }
            }
            (None, _) => Err(ProtocolError {
                code: ErrorCode::Unauthorized,
                message: "authentication required to start screen share".to_string(),
                recoverable: false,
            }),
            (_, None) => Err(ProtocolError {
                code: ErrorCode::NotInRoom,
                message: "join a room before starting screen share".to_string(),
                recoverable: true,
            }),
        },
        SignalMessage::ScreenShareStopped(mut payload) => match (authenticated_user.as_ref(), active_session.as_ref()) {
            (Some(authed), Some(session)) => {
                ensure_matching_user_id(&payload.user_id, &authed.user_id, "ScreenShareStopped")?;
                validate_safe_id(&payload.room_id, "room_id")?;
                validate_safe_id(&payload.stream_id, "stream_id")?;
                if payload.room_id != session.room_id {
                    Err(ProtocolError {
                        code: ErrorCode::Unauthorized,
                        message: "cannot stop screen share in another room".to_string(),
                        recoverable: false,
                    })
                } else {
                    payload.user_id = session.user_id.clone();
                    stop_screen_share(state, payload).await
                }
            }
            (None, _) => Err(ProtocolError {
                code: ErrorCode::Unauthorized,
                message: "authentication required to stop screen share".to_string(),
                recoverable: false,
            }),
            (_, None) => Err(ProtocolError {
                code: ErrorCode::NotInRoom,
                message: "join a room before stopping screen share".to_string(),
                recoverable: true,
            }),
        },
        SignalMessage::GamePresenceUpdate(mut payload) => match (authenticated_user.as_ref(), active_session.as_ref()) {
            (Some(authed), Some(session)) => {
                ensure_matching_user_id(&payload.user_id, &authed.user_id, "GamePresenceUpdate")?;
                if let Some(ref game_id) = payload.game_id {
                    validate_display_text(game_id, "game_id", MAX_ID_LEN, true)?;
                }
                if let Some(ref game_name) = payload.game_name {
                    validate_display_text(game_name, "game_name", MAX_TITLE_LEN, true)?;
                }
                if let Some(ref proc_name) = payload.process_name {
                    validate_display_text(proc_name, "process_name", MAX_TITLE_LEN, true)?;
                }
                payload.user_id = session.user_id.clone();
                update_game_presence(state, &session.room_id, payload).await
            }
            (None, _) => Err(ProtocolError {
                code: ErrorCode::Unauthorized,
                message: "authentication required to update game presence".to_string(),
                recoverable: false,
            }),
            (_, None) => Err(ProtocolError {
                code: ErrorCode::NotInRoom,
                message: "join a room before sending game presence updates".to_string(),
                recoverable: true,
            }),
        },
        SignalMessage::MovePeerToRoom(payload) => {
            if let Some(authed) = authenticated_user.as_ref() {
                validate_safe_id(&payload.server_id, "server_id")?;
                validate_safe_id(&payload.source_room_id, "source_room_id")?;
                validate_safe_id(&payload.target_room_id, "target_room_id")?;
                validate_safe_id(&payload.target_user_id, "target_user_id")?;
                match state
                    .auth
                    .verify_server_admin_and_voice_channel(
                        &payload.server_id,
                        &payload.target_room_id,
                        &authed.user_id,
                        bearer_token.as_deref(),
                    )
                    .await
                {
                    Ok(()) => move_peer_to_room(state, &authed.user_id, payload).await,
                    Err(err) => Err(ProtocolError {
                        code: ErrorCode::Unauthorized,
                        message: err,
                        recoverable: true,
                    }),
                }
            } else {
                Err(ProtocolError {
                    code: ErrorCode::Unauthorized,
                    message: "authentication required to move peers between rooms".to_string(),
                    recoverable: false,
                })
            }
        }
        SignalMessage::Ping(hb) => {
            let _ = tx.send(SignalMessage::Pong(hb));
            Ok(())
        }
        _ => Err(ProtocolError {
            code: ErrorCode::InvalidMessage,
            message: "unsupported client-to-server signaling message".to_string(),
            recoverable: true,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_blocks_over_30_messages_per_second_and_recovers() {
        let mut limiter = WsRateLimiter::new(MAX_MESSAGES_PER_WINDOW, RATE_LIMIT_WINDOW);
        let t0 = Instant::now();

        for _ in 0..MAX_MESSAGES_PER_WINDOW {
            assert_eq!(limiter.check(t0), RateLimitDecision::Allowed);
        }

        assert_eq!(
            limiter.check(t0),
            RateLimitDecision::Throttled { send_notice: true }
        );
        assert_eq!(
            limiter.check(t0),
            RateLimitDecision::Throttled { send_notice: false }
        );

        let after_cooldown = t0 + RATE_LIMIT_WINDOW.saturating_mul(2) + Duration::from_millis(10);
        assert_eq!(limiter.check(after_cooldown), RateLimitDecision::Allowed);
    }

    #[test]
    fn rate_limiter_disconnects_on_sustained_flood() {
        let mut limiter = WsRateLimiter::new(2, Duration::from_secs(1));
        let mut now = Instant::now();

        for strike in 1..=4 {
            assert_eq!(limiter.check(now), RateLimitDecision::Allowed);
            assert_eq!(limiter.check(now), RateLimitDecision::Allowed);
            let third = limiter.check(now);
            if strike <= MAX_CONSECUTIVE_RATE_VIOLATIONS {
                assert_eq!(third, RateLimitDecision::Throttled { send_notice: true });
            } else {
                assert_eq!(third, RateLimitDecision::Disconnect);
            }
            now += Duration::from_secs(1);
        }
    }

    #[test]
    fn validates_ids_and_rejects_user_id_spoofing() {
        assert!(validate_safe_id("550e8400-e29b-41d4-a716-446655440000", "room_id").is_ok());
        assert!(validate_safe_id("", "room_id").is_err());
        assert!(validate_safe_id("room&or=1", "room_id").is_err());

        assert!(ensure_matching_user_id("", "user-1", "LeaveRoom").is_ok());
        assert!(ensure_matching_user_id("user-1", "user-1", "LeaveRoom").is_ok());
        assert!(ensure_matching_user_id("attacker", "user-1", "LeaveRoom").is_err());
    }
}
