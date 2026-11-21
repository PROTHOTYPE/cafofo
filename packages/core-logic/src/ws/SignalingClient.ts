import { readEnvVar } from "../env";
import type {
  GamePresenceUpdate,
  Heartbeat,
  JoinRoom,
  LeaveRoom,
  LiveKitTokenIssued,
  MovePeerToRoom,
  PeerLeft,
  PeerMovedToRoom,
  PeerReconnecting,
  PeerState,
  ProtocolError,
  RoomSnapshot,
  ScreenShareStarted,
  ScreenShareStopped,
  SignalMessage,
  VoiceStateUpdate,
} from "../generated";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface SignalingEventMap {
  statusChange: ConnectionStatus;
  roomJoined: RoomSnapshot;
  liveKitTokenIssued: LiveKitTokenIssued;
  peerJoined: PeerState;
  peerLeft: PeerLeft;
  peerReconnecting: PeerReconnecting;
  voiceStateUpdate: VoiceStateUpdate;
  screenShareStarted: ScreenShareStarted;
  screenShareStopped: ScreenShareStopped;
  gamePresenceUpdate: GamePresenceUpdate;
  peerMovedToRoom: PeerMovedToRoom;
  pong: Heartbeat;
  error: ProtocolError;
}

export interface SignalingClientOptions {
  url?: string;
  accessToken?: string;
  getAccessToken?: () => string | null;
  autoReconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Resolves the WebSocket signaling URL from an explicit URL or `VITE_SIGNALING_URL`,
 * falling back dynamically to `window.location.hostname` on port `3001` (or
 * `VITE_SIGNALING_PORT`) so LAN and mobile clients reach the host's Axum server.
 */
export function resolveSignalingUrl(explicitUrl?: string): string {
  const configured = (explicitUrl ?? readEnvVar("VITE_SIGNALING_URL") ?? "").trim();
  if (configured) {
    return configured;
  }

  const port = (readEnvVar("VITE_SIGNALING_PORT") ?? "3001").trim() || "3001";
  const rawHost =
    typeof window !== "undefined" ? window.location?.hostname : undefined;
  const hostname =
    rawHost && rawHost !== "tauri.localhost" ? rawHost : "localhost";
  const protocol =
    typeof window !== "undefined" && window.location?.protocol === "https:"
      ? "wss"
      : "ws";

  return `${protocol}://${hostname}:${port}/ws`;
}

type Listener<T> = (payload: T) => void;

/**
 * Typed WebSocket signaling client backed by Rust `cafofo-protocol` contracts.
 * Supports Supabase Auth Bearer JWTs on `/ws` & `JoinRoom`, LiveKit token
 * requests, and grace-period session restoration via `reconnect_token`.
 */
export class SignalingClient {
  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly heartbeatIntervalMs: number;

  private accessToken: string | null;
  private readonly getAccessToken?: () => string | null;
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private manualDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private activeJoin: Omit<JoinRoom, "reconnect_token" | "access_token"> | null =
    null;
  private reconnectToken: string | null = null;

  private listeners: {
    [K in keyof SignalingEventMap]?: Set<Listener<SignalingEventMap[K]>>;
  } = {};

  constructor(options: SignalingClientOptions = {}) {
    this.url = resolveSignalingUrl(options.url);
    this.accessToken = options.accessToken ?? null;
    this.getAccessToken = options.getAccessToken;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 10_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  }

  get serverUrl(): string {
    return this.url;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  isOpen(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  on<K extends keyof SignalingEventMap>(
    event: K,
    listener: Listener<SignalingEventMap[K]>,
  ): () => void {
    let set = this.listeners[event] as
      | Set<Listener<SignalingEventMap[K]>>
      | undefined;
    if (!set) {
      set = new Set();
      this.listeners[event] = set as (typeof this.listeners)[K];
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.manualDisconnect = false;
    this.clearReconnectTimer();
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    const freshToken = this.getAccessToken?.();
    if (freshToken) {
      this.accessToken = freshToken;
    }

    const wsUrl = this.buildConnectionUrl();
    const ws = new WebSocket(wsUrl);
    this.socket = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("connected");
      this.startHeartbeat();

      if (this.activeJoin) {
        const latestToken = this.getAccessToken?.() ?? this.accessToken;
        if (latestToken) {
          this.accessToken = latestToken;
        }
        this.send({
          type: "JoinRoom",
          payload: {
            ...this.activeJoin,
            reconnect_token: this.reconnectToken,
            access_token: latestToken,
          },
        });
      }
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      this.handleRawMessage(event.data);
    };

    ws.onerror = () => {
      this.emit("error", {
        code: "InternalError",
        message: `WebSocket transport error (${this.url})`,
        recoverable: true,
      });
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.socket = null;

      if (this.manualDisconnect) {
        this.setStatus("disconnected");
        return;
      }

      if (this.autoReconnect) {
        this.scheduleReconnect();
      } else {
        this.setStatus("disconnected");
      }
    };
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.activeJoin = null;
    this.reconnectToken = null;
    this.clearReconnectTimer();
    this.stopHeartbeat();

    if (this.socket) {
      this.socket.close(1000, "client disconnect");
      this.socket = null;
    }
    this.setStatus("disconnected");
  }

  joinRoom(
    payload: Omit<JoinRoom, "reconnect_token" | "access_token"> & {
      access_token?: string | null;
    },
  ): void {
    if (payload.access_token !== undefined) {
      this.accessToken = payload.access_token;
    }
    this.activeJoin = {
      room_id: payload.room_id,
      user_id: payload.user_id,
      display_name: payload.display_name,
    };
    this.send({
      type: "JoinRoom",
      payload: {
        ...this.activeJoin,
        reconnect_token: this.reconnectToken,
        access_token: this.accessToken,
      },
    });
  }

  requestLiveKitToken(roomId: string): void {
    this.send({
      type: "RequestLiveKitToken",
      payload: { room_id: roomId },
    });
  }

  leaveRoom(payload: LeaveRoom): void {
    this.activeJoin = null;
    this.reconnectToken = null;
    this.send({
      type: "LeaveRoom",
      payload,
    });
  }

  updateVoiceState(payload: VoiceStateUpdate): void {
    this.send({
      type: "VoiceStateUpdate",
      payload,
    });
  }

  notifyScreenShareStarted(payload: ScreenShareStarted): void {
    this.send({
      type: "ScreenShareStarted",
      payload,
    });
  }

  notifyScreenShareStopped(payload: ScreenShareStopped): void {
    this.send({
      type: "ScreenShareStopped",
      payload,
    });
  }

  updateGamePresence(payload: GamePresenceUpdate): void {
    this.send({
      type: "GamePresenceUpdate",
      payload,
    });
  }

  movePeerToRoom(payload: MovePeerToRoom): void {
    this.send({
      type: "MovePeerToRoom",
      payload,
    });
  }

  send(message: SignalMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private buildConnectionUrl(): string {
    if (!this.accessToken) {
      return this.url;
    }
    try {
      const parsed = new URL(this.url);
      parsed.searchParams.set("token", this.accessToken);
      return parsed.toString();
    } catch {
      const sep = this.url.includes("?") ? "&" : "?";
      return `${this.url}${sep}token=${encodeURIComponent(this.accessToken)}`;
    }
  }

  private handleRawMessage(raw: string): void {
    let parsed: SignalMessage;
    try {
      parsed = JSON.parse(raw) as SignalMessage;
    } catch {
      this.emit("error", {
        code: "InvalidMessage",
        message: "Failed to parse signaling JSON from server",
        recoverable: true,
      });
      return;
    }

    switch (parsed.type) {
      case "RoomJoined":
        this.reconnectToken = parsed.payload.reconnect_token;
        this.emit("roomJoined", parsed.payload);
        break;
      case "LiveKitTokenIssued":
        this.emit("liveKitTokenIssued", parsed.payload);
        break;
      case "PeerJoined":
        this.emit("peerJoined", parsed.payload);
        break;
      case "PeerLeft":
        this.emit("peerLeft", parsed.payload);
        break;
      case "PeerReconnecting":
        this.emit("peerReconnecting", parsed.payload);
        break;
      case "VoiceStateUpdate":
        this.emit("voiceStateUpdate", parsed.payload);
        break;
      case "ScreenShareStarted":
        this.emit("screenShareStarted", parsed.payload);
        break;
      case "ScreenShareStopped":
        this.emit("screenShareStopped", parsed.payload);
        break;
      case "GamePresenceUpdate":
        this.emit("gamePresenceUpdate", parsed.payload);
        break;
      case "PeerMovedToRoom":
        this.emit("peerMovedToRoom", parsed.payload);
        break;
      case "Pong":
        this.emit("pong", parsed.payload);
        break;
      case "Error":
        this.emit("error", parsed.payload);
        break;
      default:
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: "Ping",
        payload: { timestamp_ms: Date.now() },
      });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.setStatus("reconnecting");

    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("statusChange", status);
  }

  private emit<K extends keyof SignalingEventMap>(
    event: K,
    payload: SignalingEventMap[K],
  ): void {
    const set = this.listeners[event] as
      | Set<Listener<SignalingEventMap[K]>>
      | undefined;
    if (!set) return;
    for (const listener of set) {
      listener(payload);
    }
  }
}
