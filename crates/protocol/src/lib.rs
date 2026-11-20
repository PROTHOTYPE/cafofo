//! WebSocket signaling protocol contracts shared between the Cafofo server
//! and TypeScript clients via `ts-rs`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Request sent by a client to join (or rejoin) a voice/presence room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JoinRoom {
    pub room_id: String,
    pub user_id: String,
    pub display_name: String,
    pub reconnect_token: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
}

/// Request sent by a client to explicitly leave a room without triggering a
/// reconnection grace period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LeaveRoom {
    pub room_id: String,
    pub user_id: String,
}

/// Request sent by an authenticated peer to obtain a scoped LiveKit access token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RequestLiveKitToken {
    pub room_id: String,
}

/// LiveKit connection parameters and JWT issued by the signaling server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LiveKitTokenIssued {
    pub url: String,
    pub token: String,
    pub room_name: String,
}

/// Voice channel state update for a peer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceStateUpdate {
    pub room_id: String,
    pub user_id: String,
    pub muted: bool,
    pub deafened: bool,
    pub speaking: bool,
    pub noise_suppression: bool,
}

/// Notification that a peer started sharing a window or monitor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenShareStarted {
    pub room_id: String,
    pub user_id: String,
    pub stream_id: String,
    pub source_title: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

/// Notification that a peer stopped sharing their screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenShareStopped {
    pub room_id: String,
    pub user_id: String,
    pub stream_id: String,
}

/// Active game presence detected on the client and broadcast to peers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GamePresenceUpdate {
    pub user_id: String,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub process_name: Option<String>,
    #[ts(type = "number | null")]
    pub started_at_ms: Option<u64>,
}

/// Machine-readable protocol error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum ErrorCode {
    InvalidMessage,
    RoomNotFound,
    AlreadyInRoom,
    NotInRoom,
    Unauthorized,
    RateLimited,
    InternalError,
}

/// Structured error payload returned by the signaling server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub recoverable: bool,
}

/// Reason a peer left a room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum LeaveReason {
    Left,
    TimedOut,
    Kicked,
}

/// Snapshot of a peer inside a room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PeerState {
    pub user_id: String,
    pub display_name: String,
    pub muted: bool,
    pub deafened: bool,
    pub speaking: bool,
    pub noise_suppression: bool,
    pub screen_sharing: Option<ScreenShareStarted>,
    pub game_presence: Option<GamePresenceUpdate>,
    pub reconnecting: bool,
}

/// Full room state sent to a peer upon joining or reconnecting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoomSnapshot {
    pub room_id: String,
    pub peers: Vec<PeerState>,
    pub reconnect_token: String,
}

/// Notification sent when a peer leaves a room permanently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PeerLeft {
    pub room_id: String,
    pub user_id: String,
    pub reason: LeaveReason,
}

/// Notification sent when a peer drops unexpectedly and enters the reconnect grace period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PeerReconnecting {
    pub room_id: String,
    pub user_id: String,
    #[ts(type = "number")]
    pub grace_period_ms: u64,
}

/// Heartbeat payload for connection health checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Heartbeat {
    #[ts(type = "number")]
    pub timestamp_ms: u64,
}

/// Request sent by a server owner/admin to move another peer to a target voice room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MovePeerToRoom {
    pub server_id: String,
    pub source_room_id: String,
    pub target_room_id: String,
    pub target_user_id: String,
}

/// Notification sent by the signaling server telling a peer to switch voice rooms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PeerMovedToRoom {
    pub target_room_id: String,
    pub moved_by_user_id: String,
}

/// Tagged WebSocket signaling message envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload")]
#[ts(export)]
pub enum SignalMessage {
    JoinRoom(JoinRoom),
    LeaveRoom(LeaveRoom),
    RoomJoined(RoomSnapshot),
    RequestLiveKitToken(RequestLiveKitToken),
    LiveKitTokenIssued(LiveKitTokenIssued),
    PeerJoined(PeerState),
    PeerLeft(PeerLeft),
    PeerReconnecting(PeerReconnecting),
    VoiceStateUpdate(VoiceStateUpdate),
    ScreenShareStarted(ScreenShareStarted),
    ScreenShareStopped(ScreenShareStopped),
    GamePresenceUpdate(GamePresenceUpdate),
    MovePeerToRoom(MovePeerToRoom),
    PeerMovedToRoom(PeerMovedToRoom),
    Ping(Heartbeat),
    Pong(Heartbeat),
    Error(ProtocolError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn roundtrip_signal_message_json() {
        let msg = SignalMessage::JoinRoom(JoinRoom {
            room_id: "room-1".to_string(),
            user_id: "user-1".to_string(),
            display_name: "Pedro".to_string(),
            reconnect_token: None,
            access_token: Some("jwt-token".to_string()),
        });

        let json = serde_json::to_string(&msg).expect("serialize SignalMessage");
        let parsed: SignalMessage = serde_json::from_str(&json).expect("deserialize SignalMessage");
        assert_eq!(msg, parsed);
    }

    #[test]
    fn export_typescript_barrel() {
        let export_dir = std::env::var("TS_RS_EXPORT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("../../packages/core-logic/src/generated"));

        SignalMessage::export_all_to(&export_dir).expect("export ts-rs bindings");

        let barrel = [
            "export type { ErrorCode } from './ErrorCode';",
            "export type { GamePresenceUpdate } from './GamePresenceUpdate';",
            "export type { Heartbeat } from './Heartbeat';",
            "export type { JoinRoom } from './JoinRoom';",
            "export type { LeaveReason } from './LeaveReason';",
            "export type { LeaveRoom } from './LeaveRoom';",
            "export type { LiveKitTokenIssued } from './LiveKitTokenIssued';",
            "export type { MovePeerToRoom } from './MovePeerToRoom';",
            "export type { PeerLeft } from './PeerLeft';",
            "export type { PeerMovedToRoom } from './PeerMovedToRoom';",
            "export type { PeerReconnecting } from './PeerReconnecting';",
            "export type { PeerState } from './PeerState';",
            "export type { ProtocolError } from './ProtocolError';",
            "export type { RequestLiveKitToken } from './RequestLiveKitToken';",
            "export type { RoomSnapshot } from './RoomSnapshot';",
            "export type { ScreenShareStarted } from './ScreenShareStarted';",
            "export type { ScreenShareStopped } from './ScreenShareStopped';",
            "export type { SignalMessage } from './SignalMessage';",
            "export type { VoiceStateUpdate } from './VoiceStateUpdate';",
            "",
        ]
        .join("\n");

        fs::write(export_dir.join("index.ts"), barrel).expect("write generated index.ts");
    }
}
