use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use cafofo_protocol::{
    ErrorCode, GamePresenceUpdate, JoinRoom, LeaveReason, LeaveRoom, LiveKitTokenIssued,
    MovePeerToRoom, PeerLeft, PeerMovedToRoom, PeerReconnecting, PeerState, ProtocolError,
    RequestLiveKitToken, RoomSnapshot, ScreenShareStarted, ScreenShareStopped, SignalMessage,
    VoiceStateUpdate,
};
use livekit_api::access_token::{AccessToken, VideoGrants};
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::auth::{LiveKitConfig, SupabaseAuth};
use crate::music::MusicHub;

pub type SharedRooms = Arc<RwLock<HashMap<String, RoomState>>>;

#[derive(Clone)]
pub struct AppState {
    pub rooms: SharedRooms,
    pub grace_period: Duration,
    pub auth: SupabaseAuth,
    pub livekit: LiveKitConfig,
    pub music: MusicHub,
}

impl AppState {
    pub fn new(grace_period: Duration, auth: SupabaseAuth, livekit: LiveKitConfig) -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            grace_period,
            auth,
            livekit,
            music: MusicHub::default(),
        }
    }

    pub async fn active_room_count(&self) -> usize {
        self.rooms.read().await.len()
    }
}

pub struct ConnectedPeer {
    pub connection_id: Uuid,
    pub reconnect_token: String,
    pub state: PeerState,
    pub tx: mpsc::UnboundedSender<SignalMessage>,
}

pub struct PendingReconnect {
    pub reconnect_token: String,
    pub state: PeerState,
    pub timer_handle: JoinHandle<()>,
}

#[derive(Default)]
pub struct RoomState {
    pub peers: HashMap<String, ConnectedPeer>,
    pub pending_disconnects: HashMap<String, PendingReconnect>,
}

impl RoomState {
    fn is_empty(&self) -> bool {
        self.peers.is_empty() && self.pending_disconnects.is_empty()
    }

    fn snapshot_peers(&self) -> Vec<PeerState> {
        self.peers
            .values()
            .map(|p| p.state.clone())
            .chain(self.pending_disconnects.values().map(|p| p.state.clone()))
            .collect()
    }

    fn broadcast_except(&self, excluded_user_id: &str, message: &SignalMessage) {
        for (uid, peer) in &self.peers {
            if uid != excluded_user_id {
                let _ = peer.tx.send(message.clone());
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActiveSession {
    pub connection_id: Uuid,
    pub room_id: String,
    pub user_id: String,
}

pub async fn join_room(
    state: &AppState,
    payload: JoinRoom,
    connection_id: Uuid,
    tx: mpsc::UnboundedSender<SignalMessage>,
) -> Result<ActiveSession, ProtocolError> {
    if payload.room_id.trim().is_empty() || payload.user_id.trim().is_empty() {
        return Err(ProtocolError {
            code: ErrorCode::InvalidMessage,
            message: "room_id and user_id cannot be empty".to_string(),
            recoverable: false,
        });
    }

    let mut rooms = state.rooms.write().await;

    // Atomically evict the user from any OTHER room they were connected to or reconnecting in,
    // so switching voice channels immediately clears their presence in the previous room.
    let mut empty_other_rooms = Vec::new();
    for (other_room_id, other_room) in rooms.iter_mut() {
        if other_room_id == &payload.room_id {
            continue;
        }
        let removed_active = other_room.peers.remove(&payload.user_id).is_some();
        let removed_pending =
            if let Some(pending) = other_room.pending_disconnects.remove(&payload.user_id) {
                pending.timer_handle.abort();
                true
            } else {
                false
            };

        if removed_active || removed_pending {
            other_room.broadcast_except(
                &payload.user_id,
                &SignalMessage::PeerLeft(PeerLeft {
                    room_id: other_room_id.clone(),
                    user_id: payload.user_id.clone(),
                    reason: LeaveReason::Left,
                }),
            );
            if other_room.is_empty() {
                empty_other_rooms.push(other_room_id.clone());
            }
        }
    }
    for empty_id in empty_other_rooms {
        rooms.remove(&empty_id);
    }

    let room = rooms.entry(payload.room_id.clone()).or_default();

    let (peer_state, reconnect_token, restored, superseded) =
        if let Some(existing) = room.peers.remove(&payload.user_id) {
            // Supersede stale connection for the same user in this room (e.g. fast WS reconnect
            // before half-open TCP socket closes) while preserving mute/deafen/screen-share state.
            let mut preserved = existing.state;
            preserved.display_name = payload.display_name;
            preserved.reconnecting = false;
            (preserved, existing.reconnect_token, true, true)
        } else if let Some(pending) = room.pending_disconnects.remove(&payload.user_id) {
            match payload.reconnect_token.as_deref() {
                Some(token) if token == pending.reconnect_token => {
                    pending.timer_handle.abort();
                    let mut restored_state = pending.state;
                    restored_state.display_name = payload.display_name;
                    restored_state.reconnecting = false;
                    (restored_state, pending.reconnect_token, true, false)
                }
                Some(_) => {
                    room.pending_disconnects
                        .insert(payload.user_id.clone(), pending);
                    return Err(ProtocolError {
                        code: ErrorCode::Unauthorized,
                        message: "invalid reconnect token".to_string(),
                        recoverable: false,
                    });
                }
                None => {
                    pending.timer_handle.abort();
                    (
                        default_peer_state(&payload.user_id, &payload.display_name),
                        Uuid::new_v4().to_string(),
                        false,
                        false,
                    )
                }
            }
        } else {
            (
                default_peer_state(&payload.user_id, &payload.display_name),
                Uuid::new_v4().to_string(),
                false,
                false,
            )
        };

    room.peers.insert(
        payload.user_id.clone(),
        ConnectedPeer {
            connection_id,
            reconnect_token: reconnect_token.clone(),
            state: peer_state.clone(),
            tx: tx.clone(),
        },
    );

    let snapshot = RoomSnapshot {
        room_id: payload.room_id.clone(),
        peers: room.snapshot_peers(),
        reconnect_token,
    };

    let _ = tx.send(SignalMessage::RoomJoined(snapshot));
    if !superseded {
        room.broadcast_except(&payload.user_id, &SignalMessage::PeerJoined(peer_state));
    }

    tracing::info!(
        room_id = %payload.room_id,
        user_id = %payload.user_id,
        restored,
        "peer joined room"
    );

    Ok(ActiveSession {
        connection_id,
        room_id: payload.room_id,
        user_id: payload.user_id,
    })
}

pub async fn issue_livekit_token(
    state: &AppState,
    session: &ActiveSession,
    request: RequestLiveKitToken,
    request_host: Option<&str>,
    origin_host: Option<&str>,
) -> Result<LiveKitTokenIssued, ProtocolError> {
    if request.room_id != session.room_id {
        return Err(ProtocolError {
            code: ErrorCode::Unauthorized,
            message: "cannot request LiveKit token for a room you have not joined".to_string(),
            recoverable: false,
        });
    }

    if state.livekit.api_key.is_empty() || state.livekit.api_secret.is_empty() {
        return Err(ProtocolError {
            code: ErrorCode::InternalError,
            message: "LiveKit API credentials are not configured on server".to_string(),
            recoverable: false,
        });
    }

    let display_name = {
        let rooms = state.rooms.read().await;
        rooms
            .get(&session.room_id)
            .and_then(|r| r.peers.get(&session.user_id))
            .map(|p| p.state.display_name.clone())
            .unwrap_or_else(|| session.user_id.clone())
    };

    let grants = VideoGrants {
        room_join: true,
        room: request.room_id.clone(),
        can_publish: Some(true),
        can_subscribe: Some(true),
        can_publish_data: Some(true),
        ..Default::default()
    };

    let jwt = AccessToken::with_api_key(&state.livekit.api_key, &state.livekit.api_secret)
        .with_identity(&session.user_id)
        .with_name(&display_name)
        .with_grants(grants)
        .to_jwt()
        .map_err(|e| ProtocolError {
            code: ErrorCode::InternalError,
            message: format!("failed to sign LiveKit access token: {e}"),
            recoverable: true,
        })?;

    Ok(LiveKitTokenIssued {
        url: resolve_client_livekit_url(&state.livekit.url, request_host, origin_host),
        token: jwt,
        room_name: request.room_id,
    })
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']);
    normalized.eq_ignore_ascii_case("localhost")
        || normalized == "127.0.0.1"
        || normalized == "::1"
}

fn is_local_desktop_host(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    is_loopback_host(&normalized)
        || normalized == "tauri.localhost"
        || normalized.ends_with(".tauri.localhost")
}

fn is_private_lan_ipv4(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']);
    match normalized.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_private() || ip.is_link_local(),
        _ => false,
    }
}

fn resolve_client_livekit_url(
    configured_url: &str,
    request_host: Option<&str>,
    origin_host: Option<&str>,
) -> String {
    let Some((scheme, rest)) = configured_url.split_once("://") else {
        return configured_url.to_string();
    };
    let (authority, path_suffix) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };
    let (configured_host, port_suffix) = if let Some(bracketed_end) = authority
        .strip_prefix('[')
        .and_then(|s| s.find(']'))
    {
        let host_part = &authority[..=bracketed_end + 1];
        let rest_part = &authority[bracketed_end + 2..];
        (host_part, rest_part)
    } else if let Some((h, _)) = authority.split_once(':') {
        (h, &authority[h.len()..])
    } else {
        (authority, "")
    };

    // Never rewrite public/cloud hosts (e.g. *.livekit.cloud) or non-loopback hosts.
    if !is_loopback_host(configured_host) {
        return configured_url.to_string();
    }

    let req_host = request_host.map(str::trim).filter(|h| !h.is_empty());
    let orig_host = origin_host.map(str::trim).filter(|h| !h.is_empty());

    let is_local_desktop = orig_host.is_some_and(is_local_desktop_host)
        || req_host.is_some_and(is_local_desktop_host);

    if is_local_desktop {
        return format!("{scheme}://127.0.0.1{port_suffix}{path_suffix}");
    }

    if let Some(lan_host) = req_host.filter(|h| is_private_lan_ipv4(h)) {
        return format!("{scheme}://{lan_host}{port_suffix}{path_suffix}");
    }

    configured_url.to_string()
}

pub async fn leave_room(state: &AppState, payload: LeaveRoom) -> Result<(), ProtocolError> {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(&payload.room_id) else {
        return Err(ProtocolError {
            code: ErrorCode::RoomNotFound,
            message: format!("room '{}' not found", payload.room_id),
            recoverable: false,
        });
    };

    let removed_peer = room.peers.remove(&payload.user_id).is_some();
    let removed_pending = if let Some(pending) = room.pending_disconnects.remove(&payload.user_id) {
        pending.timer_handle.abort();
        true
    } else {
        false
    };

    if !removed_peer && !removed_pending {
        return Err(ProtocolError {
            code: ErrorCode::NotInRoom,
            message: format!(
                "user '{}' is not in room '{}'",
                payload.user_id, payload.room_id
            ),
            recoverable: false,
        });
    }

    room.broadcast_except(
        &payload.user_id,
        &SignalMessage::PeerLeft(PeerLeft {
            room_id: payload.room_id.clone(),
            user_id: payload.user_id.clone(),
            reason: LeaveReason::Left,
        }),
    );

    if room.is_empty() {
        rooms.remove(&payload.room_id);
    }

    tracing::info!(room_id = %payload.room_id, user_id = %payload.user_id, "peer left room");
    Ok(())
}

pub async fn update_voice_state(
    state: &AppState,
    payload: VoiceStateUpdate,
) -> Result<(), ProtocolError> {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(&payload.room_id) else {
        return Err(ProtocolError {
            code: ErrorCode::RoomNotFound,
            message: format!("room '{}' not found", payload.room_id),
            recoverable: false,
        });
    };

    let Some(peer) = room.peers.get_mut(&payload.user_id) else {
        return Err(ProtocolError {
            code: ErrorCode::NotInRoom,
            message: format!("user '{}' is not connected to room", payload.user_id),
            recoverable: false,
        });
    };

    peer.state.muted = payload.muted;
    peer.state.deafened = payload.deafened;
    peer.state.speaking = payload.speaking;
    peer.state.noise_suppression = payload.noise_suppression;

    let user_id = payload.user_id.clone();
    room.broadcast_except(&user_id, &SignalMessage::VoiceStateUpdate(payload));
    Ok(())
}

pub async fn start_screen_share(
    state: &AppState,
    payload: ScreenShareStarted,
) -> Result<(), ProtocolError> {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(&payload.room_id) else {
        return Err(ProtocolError {
            code: ErrorCode::RoomNotFound,
            message: format!("room '{}' not found", payload.room_id),
            recoverable: false,
        });
    };

    let Some(peer) = room.peers.get_mut(&payload.user_id) else {
        return Err(ProtocolError {
            code: ErrorCode::NotInRoom,
            message: format!("user '{}' is not connected to room", payload.user_id),
            recoverable: false,
        });
    };

    peer.state.screen_sharing = Some(payload.clone());
    let user_id = payload.user_id.clone();
    room.broadcast_except(&user_id, &SignalMessage::ScreenShareStarted(payload));
    Ok(())
}

pub async fn stop_screen_share(
    state: &AppState,
    payload: ScreenShareStopped,
) -> Result<(), ProtocolError> {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(&payload.room_id) else {
        return Err(ProtocolError {
            code: ErrorCode::RoomNotFound,
            message: format!("room '{}' not found", payload.room_id),
            recoverable: false,
        });
    };

    let Some(peer) = room.peers.get_mut(&payload.user_id) else {
        return Err(ProtocolError {
            code: ErrorCode::NotInRoom,
            message: format!("user '{}' is not connected to room", payload.user_id),
            recoverable: false,
        });
    };

    peer.state.screen_sharing = None;
    let user_id = payload.user_id.clone();
    room.broadcast_except(&user_id, &SignalMessage::ScreenShareStopped(payload));
    Ok(())
}

pub async fn update_game_presence(
    state: &AppState,
    room_id: &str,
    payload: GamePresenceUpdate,
) -> Result<(), ProtocolError> {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(room_id) else {
        return Err(ProtocolError {
            code: ErrorCode::RoomNotFound,
            message: format!("room '{room_id}' not found"),
            recoverable: false,
        });
    };

    let Some(peer) = room.peers.get_mut(&payload.user_id) else {
        return Err(ProtocolError {
            code: ErrorCode::NotInRoom,
            message: format!("user '{}' is not connected to room", payload.user_id),
            recoverable: false,
        });
    };

    let presence = if payload.game_id.is_some() || payload.game_name.is_some() {
        Some(payload.clone())
    } else {
        None
    };
    peer.state.game_presence = presence;

    let user_id = payload.user_id.clone();
    room.broadcast_except(&user_id, &SignalMessage::GamePresenceUpdate(payload));
    Ok(())
}

pub async fn move_peer_to_room(
    state: &AppState,
    actor_user_id: &str,
    payload: MovePeerToRoom,
) -> Result<(), ProtocolError> {
    if payload.source_room_id == payload.target_room_id {
        return Ok(());
    }

    let rooms = state.rooms.read().await;
    let target_tx = rooms
        .get(&payload.source_room_id)
        .and_then(|room| room.peers.get(&payload.target_user_id))
        .map(|peer| peer.tx.clone())
        .ok_or_else(|| ProtocolError {
            code: ErrorCode::NotInRoom,
            message: format!(
                "user '{}' is not active in voice room '{}'",
                payload.target_user_id, payload.source_room_id
            ),
            recoverable: true,
        })?;

    let _ = target_tx.send(SignalMessage::PeerMovedToRoom(PeerMovedToRoom {
        target_room_id: payload.target_room_id.clone(),
        moved_by_user_id: actor_user_id.to_string(),
    }));

    tracing::info!(
        %actor_user_id,
        target_user_id = %payload.target_user_id,
        source_room_id = %payload.source_room_id,
        target_room_id = %payload.target_room_id,
        "dispatched PeerMovedToRoom command"
    );

    Ok(())
}

pub async fn handle_unexpected_disconnect(state: AppState, session: ActiveSession) {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(&session.room_id) else {
        return;
    };

    let matches_active = room
        .peers
        .get(&session.user_id)
        .is_some_and(|peer| peer.connection_id == session.connection_id);

    if !matches_active {
        return;
    }

    let Some(mut peer) = room.peers.remove(&session.user_id) else {
        return;
    };

    peer.state.reconnecting = true;
    peer.state.speaking = false;

    let reconnect_token = peer.reconnect_token.clone();
    let grace_period = state.grace_period;
    let grace_period_ms = u64::try_from(grace_period.as_millis()).unwrap_or(u64::MAX);

    room.broadcast_except(
        &session.user_id,
        &SignalMessage::PeerReconnecting(PeerReconnecting {
            room_id: session.room_id.clone(),
            user_id: session.user_id.clone(),
            grace_period_ms,
        }),
    );

    let state_clone = state.clone();
    let room_id = session.room_id.clone();
    let user_id = session.user_id.clone();
    let expected_token = reconnect_token.clone();

    let timer_handle = tokio::spawn(async move {
        tokio::time::sleep(grace_period).await;
        expire_pending_reconnect(&state_clone, &room_id, &user_id, &expected_token).await;
    });

    if let Some(old_pending) = room.pending_disconnects.insert(
        session.user_id,
        PendingReconnect {
            reconnect_token,
            state: peer.state,
            timer_handle,
        },
    ) {
        old_pending.timer_handle.abort();
    }
}

async fn expire_pending_reconnect(
    state: &AppState,
    room_id: &str,
    user_id: &str,
    expected_token: &str,
) {
    let mut rooms = state.rooms.write().await;
    let Some(room) = rooms.get_mut(room_id) else {
        return;
    };

    let should_remove = room
        .pending_disconnects
        .get(user_id)
        .is_some_and(|pending| pending.reconnect_token == expected_token);

    if !should_remove {
        return;
    }

    room.pending_disconnects.remove(user_id);
    room.broadcast_except(
        user_id,
        &SignalMessage::PeerLeft(PeerLeft {
            room_id: room_id.to_string(),
            user_id: user_id.to_string(),
            reason: LeaveReason::TimedOut,
        }),
    );

    if room.is_empty() {
        rooms.remove(room_id);
    }

    tracing::info!(%room_id, %user_id, "peer reconnect grace period expired");
}

fn default_peer_state(user_id: &str, display_name: &str) -> PeerState {
    PeerState {
        user_id: user_id.to_string(),
        display_name: display_name.to_string(),
        muted: false,
        deafened: false,
        speaking: false,
        noise_suppression: true,
        screen_sharing: None,
        game_presence: None,
        reconnecting: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(grace_period: Duration) -> AppState {
        AppState::new(
            grace_period,
            SupabaseAuth::new(String::new(), String::new()),
            LiveKitConfig {
                url: "ws://localhost:7880".into(),
                api_key: "devkey".into(),
                api_secret: "secret_secret_secret_secret_123456".into(),
            },
        )
    }

    #[tokio::test]
    async fn join_issue_livekit_token_and_grace_period_reconnect() {
        let state = test_state(Duration::from_millis(200));
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();

        let session_a = join_room(
            &state,
            JoinRoom {
                room_id: "cafe".into(),
                user_id: "alice".into(),
                display_name: "Alice".into(),
                reconnect_token: None,
                access_token: None,
            },
            Uuid::new_v4(),
            tx_a,
        )
        .await
        .expect("alice joins");

        let token_a = match rx_a.recv().await.expect("RoomJoined") {
            SignalMessage::RoomJoined(snap) => snap.reconnect_token,
            other => panic!("unexpected message: {other:?}"),
        };

        let lk = issue_livekit_token(
            &state,
            &session_a,
            RequestLiveKitToken {
                room_id: "cafe".into(),
            },
            Some("192.168.1.50"),
            Some("192.168.1.50"),
        )
        .await
        .expect("livekit token issued");
        assert_eq!(lk.room_name, "cafe");
        assert_eq!(lk.url, "ws://192.168.1.50:7880");
        assert!(!lk.token.is_empty());

        join_room(
            &state,
            JoinRoom {
                room_id: "cafe".into(),
                user_id: "bob".into(),
                display_name: "Bob".into(),
                reconnect_token: None,
                access_token: None,
            },
            Uuid::new_v4(),
            tx_b,
        )
        .await
        .expect("bob joins");
        let _ = rx_b.recv().await;
        let _ = rx_a.recv().await;

        update_voice_state(
            &state,
            VoiceStateUpdate {
                room_id: "cafe".into(),
                user_id: "alice".into(),
                muted: true,
                deafened: false,
                speaking: false,
                noise_suppression: true,
            },
        )
        .await
        .expect("voice update");
        let _ = rx_b.recv().await;

        handle_unexpected_disconnect(state.clone(), session_a).await;
        match rx_b.recv().await.expect("PeerReconnecting") {
            SignalMessage::PeerReconnecting(ev) => assert_eq!(ev.user_id, "alice"),
            other => panic!("unexpected message: {other:?}"),
        }

        let (tx_a2, mut rx_a2) = mpsc::unbounded_channel();
        join_room(
            &state,
            JoinRoom {
                room_id: "cafe".into(),
                user_id: "alice".into(),
                display_name: "Alice".into(),
                reconnect_token: Some(token_a),
                access_token: None,
            },
            Uuid::new_v4(),
            tx_a2,
        )
        .await
        .expect("alice reconnects");

        match rx_a2.recv().await.expect("RoomJoined") {
            SignalMessage::RoomJoined(snap) => {
                let alice = snap.peers.iter().find(|p| p.user_id == "alice").unwrap();
                assert!(alice.muted);
                assert!(!alice.reconnecting);
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[tokio::test]
    async fn grace_period_expiration_evicts_peer() {
        let state = test_state(Duration::from_millis(50));
        let (tx_a, _rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();

        let session_a = join_room(
            &state,
            JoinRoom {
                room_id: "cafe".into(),
                user_id: "alice".into(),
                display_name: "Alice".into(),
                reconnect_token: None,
                access_token: None,
            },
            Uuid::new_v4(),
            tx_a,
        )
        .await
        .unwrap();

        join_room(
            &state,
            JoinRoom {
                room_id: "cafe".into(),
                user_id: "bob".into(),
                display_name: "Bob".into(),
                reconnect_token: None,
                access_token: None,
            },
            Uuid::new_v4(),
            tx_b,
        )
        .await
        .unwrap();
        let _ = rx_b.recv().await;

        handle_unexpected_disconnect(state.clone(), session_a).await;
        let _ = rx_b.recv().await;

        tokio::time::sleep(Duration::from_millis(120)).await;
        match rx_b.recv().await.expect("PeerLeft") {
            SignalMessage::PeerLeft(left) => {
                assert_eq!(left.user_id, "alice");
                assert_eq!(left.reason, LeaveReason::TimedOut);
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn resolves_livekit_url_for_desktop_and_lan_while_preserving_cloud_urls() {
        assert_eq!(
            resolve_client_livekit_url(
                "ws://localhost:7880",
                Some("localhost"),
                Some("tauri.localhost"),
            ),
            "ws://127.0.0.1:7880"
        );
        assert_eq!(
            resolve_client_livekit_url(
                "ws://127.0.0.1:7880",
                Some("192.168.1.50"),
                Some("tauri.localhost"),
            ),
            "ws://127.0.0.1:7880"
        );
        assert_eq!(
            resolve_client_livekit_url(
                "ws://127.0.0.1:7880",
                Some("10.0.0.25"),
                Some("10.0.0.25"),
            ),
            "ws://10.0.0.25:7880"
        );
        assert_eq!(
            resolve_client_livekit_url(
                "ws://127.0.0.1:7880",
                Some("cafofo-signaling.fly.dev"),
                Some("cafofo.pages.dev"),
            ),
            "ws://127.0.0.1:7880"
        );
        assert_eq!(
            resolve_client_livekit_url(
                "wss://cafofo-4iwrudhu.livekit.cloud",
                Some("192.168.1.50"),
                Some("192.168.1.50"),
            ),
            "wss://cafofo-4iwrudhu.livekit.cloud"
        );
        assert_eq!(
            resolve_client_livekit_url(
                "wss://cafofo-4iwrudhu.livekit.cloud",
                Some("localhost"),
                Some("tauri.localhost"),
            ),
            "wss://cafofo-4iwrudhu.livekit.cloud"
        );
    }

    #[tokio::test]
    async fn switching_rooms_evicts_user_from_previous_room_immediately() {
        let state = test_state(Duration::from_secs(10));
        let (tx_a1, _rx_a1) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        let (tx_a2, mut rx_a2) = mpsc::unbounded_channel();

        join_room(
            &state,
            JoinRoom {
                room_id: "room-1".into(),
                user_id: "alice".into(),
                display_name: "Alice".into(),
                reconnect_token: None,
                access_token: None,
            },
            Uuid::new_v4(),
            tx_a1,
        )
        .await
        .unwrap();

        join_room(
            &state,
            JoinRoom {
                room_id: "room-1".into(),
                user_id: "bob".into(),
                display_name: "Bob".into(),
                reconnect_token: None,
                access_token: None,
            },
            Uuid::new_v4(),
            tx_b,
        )
        .await
        .unwrap();
        let _ = rx_b.recv().await; // RoomJoined

        join_room(
            &state,
            JoinRoom {
                room_id: "room-2".into(),
                user_id: "alice".into(),
                display_name: "Alice".into(),
                reconnect_token: None,
                access_token: None,
            },
            Uuid::new_v4(),
            tx_a2,
        )
        .await
        .unwrap();

        match rx_b.recv().await.expect("Bob receives PeerLeft from room-1") {
            SignalMessage::PeerLeft(ev) => {
                assert_eq!(ev.room_id, "room-1");
                assert_eq!(ev.user_id, "alice");
            }
            other => panic!("unexpected message for Bob: {other:?}"),
        }

        match rx_a2.recv().await.expect("Alice receives RoomJoined for room-2") {
            SignalMessage::RoomJoined(snap) => {
                assert_eq!(snap.room_id, "room-2");
                assert_eq!(snap.peers.len(), 1);
            }
            other => panic!("unexpected message for Alice: {other:?}"),
        }
    }
}
