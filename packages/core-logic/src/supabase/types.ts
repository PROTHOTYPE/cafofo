export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ChannelType = "text" | "voice";
export type MemberRole = "owner" | "admin" | "member";
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
export type FriendshipStatus = "pending" | "accepted" | "blocked";
export type AvatarFrameStyle =
  | "none"
  | "crimson-pulse"
  | "cyber-cut"
  | "double-neon";
export type ProfileCardTheme =
  | "default"
  | "obsidian-glass"
  | "liquid-water"
  | "crimson-fire"
  | "cyber-hologram"
  | "neon-grid";

export interface MessageAttachment {
  name: string;
  url: string;
  path: string;
  mime_type: string;
  size: number;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string;
          display_name: string;
          avatar_url: string | null;
          bio: string | null;
          status: PresenceStatus;
          custom_status: string | null;
          custom_status_text: string | null;
          custom_status_emoji: string | null;
          banner_url: string | null;
          banner_color: string | null;
          banner_gradient: string | null;
          card_bg_color: string | null;
          card_accent_color: string | null;
          card_text_color: string | null;
          card_border_color: string | null;
          custom_badge_text: string | null;
          custom_badge_color: string | null;
          avatar_frame: AvatarFrameStyle;
          card_theme: ProfileCardTheme;
          entry_sound_url: string | null;
          entry_sound_volume: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          username: string;
          display_name: string;
          avatar_url?: string | null;
          bio?: string | null;
          status?: PresenceStatus;
          custom_status?: string | null;
          custom_status_text?: string | null;
          custom_status_emoji?: string | null;
          banner_url?: string | null;
          banner_color?: string | null;
          banner_gradient?: string | null;
          card_bg_color?: string | null;
          card_accent_color?: string | null;
          card_text_color?: string | null;
          card_border_color?: string | null;
          custom_badge_text?: string | null;
          custom_badge_color?: string | null;
          avatar_frame?: AvatarFrameStyle;
          card_theme?: ProfileCardTheme;
          entry_sound_url?: string | null;
          entry_sound_volume?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          username?: string;
          display_name?: string;
          avatar_url?: string | null;
          bio?: string | null;
          status?: PresenceStatus;
          custom_status?: string | null;
          custom_status_text?: string | null;
          custom_status_emoji?: string | null;
          banner_url?: string | null;
          banner_color?: string | null;
          banner_gradient?: string | null;
          card_bg_color?: string | null;
          card_accent_color?: string | null;
          card_text_color?: string | null;
          card_border_color?: string | null;
          custom_badge_text?: string | null;
          custom_badge_color?: string | null;
          avatar_frame?: AvatarFrameStyle;
          card_theme?: ProfileCardTheme;
          entry_sound_url?: string | null;
          entry_sound_volume?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      servers: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          icon_url: string | null;
          banner_url: string | null;
          invite_code: string;
          owner_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
          icon_url?: string | null;
          banner_url?: string | null;
          invite_code?: string;
          owner_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string | null;
          icon_url?: string | null;
          banner_url?: string | null;
          invite_code?: string;
          owner_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "servers_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      server_roles: {
        Row: {
          id: string;
          server_id: string;
          name: string;
          color: string;
          position: number;
          permissions: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          server_id: string;
          name: string;
          color?: string;
          position?: number;
          permissions?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          server_id?: string;
          name?: string;
          color?: string;
          position?: number;
          permissions?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "server_roles_server_id_fkey";
            columns: ["server_id"];
            isOneToOne: false;
            referencedRelation: "servers";
            referencedColumns: ["id"];
          },
        ];
      };
      server_members: {
        Row: {
          server_id: string;
          user_id: string;
          role: MemberRole;
          role_id: string | null;
          nickname: string | null;
          joined_at: string;
        };
        Insert: {
          server_id: string;
          user_id: string;
          role?: MemberRole;
          role_id?: string | null;
          nickname?: string | null;
          joined_at?: string;
        };
        Update: {
          server_id?: string;
          user_id?: string;
          role?: MemberRole;
          role_id?: string | null;
          nickname?: string | null;
          joined_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "server_members_server_id_fkey";
            columns: ["server_id"];
            isOneToOne: false;
            referencedRelation: "servers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "server_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "server_members_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "server_roles";
            referencedColumns: ["id"];
          },
        ];
      };
      channels: {
        Row: {
          id: string;
          server_id: string;
          name: string;
          topic: string | null;
          type: ChannelType;
          position: number;
          bitrate: number | null;
          user_limit: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          server_id: string;
          name: string;
          topic?: string | null;
          type?: ChannelType;
          position?: number;
          bitrate?: number | null;
          user_limit?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          server_id?: string;
          name?: string;
          topic?: string | null;
          type?: ChannelType;
          position?: number;
          bitrate?: number | null;
          user_limit?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channels_server_id_fkey";
            columns: ["server_id"];
            isOneToOne: false;
            referencedRelation: "servers";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          id: string;
          channel_id: string;
          author_id: string;
          content: string;
          reply_to_id: string | null;
          attachments: Json;
          edited_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          channel_id: string;
          author_id: string;
          content: string;
          reply_to_id?: string | null;
          attachments?: Json;
          edited_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          channel_id?: string;
          author_id?: string;
          content?: string;
          reply_to_id?: string | null;
          attachments?: Json;
          edited_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      game_catalog: {
        Row: {
          id: string;
          slug: string;
          name: string;
          executables: string[];
          icon_url: string | null;
          cover_url: string | null;
          verified: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          executables?: string[];
          icon_url?: string | null;
          cover_url?: string | null;
          verified?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          slug?: string;
          name?: string;
          executables?: string[];
          icon_url?: string | null;
          cover_url?: string | null;
          verified?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      friendships: {
        Row: {
          id: string;
          requester_id: string;
          addressee_id: string;
          pair_low: string;
          pair_high: string;
          status: FriendshipStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          requester_id: string;
          addressee_id: string;
          status?: FriendshipStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          status?: FriendshipStatus;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "friendships_requester_id_fkey";
            columns: ["requester_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "friendships_addressee_id_fkey";
            columns: ["addressee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      direct_channels: {
        Row: {
          id: string;
          user_a: string;
          user_b: string;
          last_message_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_a: string;
          user_b: string;
          last_message_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          last_message_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "direct_channels_user_a_fkey";
            columns: ["user_a"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "direct_channels_user_b_fkey";
            columns: ["user_b"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      direct_messages: {
        Row: {
          id: string;
          dm_channel_id: string;
          author_id: string;
          content: string;
          reply_to_id: string | null;
          attachments: Json;
          edited_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          dm_channel_id: string;
          author_id: string;
          content?: string;
          reply_to_id?: string | null;
          attachments?: Json;
          edited_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          content?: string;
          reply_to_id?: string | null;
          attachments?: Json;
          edited_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "direct_messages_dm_channel_id_fkey";
            columns: ["dm_channel_id"];
            isOneToOne: false;
            referencedRelation: "direct_channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "direct_messages_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      room_music_state: {
        Row: {
          room_id: string;
          current_track: Json | null;
          queue: Json;
          is_playing: boolean;
          started_at_ms: number;
          paused_offset_sec: number;
          version: number;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          room_id: string;
          current_track?: Json | null;
          queue?: Json;
          is_playing?: boolean;
          started_at_ms?: number;
          paused_offset_sec?: number;
          version?: number;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          room_id?: string;
          current_track?: Json | null;
          queue?: Json;
          is_playing?: boolean;
          started_at_ms?: number;
          paused_offset_sec?: number;
          version?: number;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_server_member: {
        Args: {
          p_server_id: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      is_dm_participant: {
        Args: {
          p_dm_channel_id: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      join_server_by_invite: {
        Args: {
          p_invite_code: string;
        };
        Returns: Database["public"]["Tables"]["servers"]["Row"];
      };
      regenerate_server_invite: {
        Args: {
          p_server_id: string;
        };
        Returns: string;
      };
      get_or_create_dm_channel: {
        Args: {
          p_other_user_id: string;
        };
        Returns: Database["public"]["Tables"]["direct_channels"]["Row"];
      };
      send_friend_request_by_username: {
        Args: {
          p_username: string;
        };
        Returns: Database["public"]["Tables"]["friendships"]["Row"];
      };
      accept_friend_request: {
        Args: {
          p_friendship_id: string;
        };
        Returns: Database["public"]["Tables"]["friendships"]["Row"];
      };
    };
    Enums: {
      channel_type: ChannelType;
      member_role: MemberRole;
      presence_status: PresenceStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}

export type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
export type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];
export type ServerRow = Database["public"]["Tables"]["servers"]["Row"];
export type ServerRoleRow = Database["public"]["Tables"]["server_roles"]["Row"];
export type ServerMemberRow =
  Database["public"]["Tables"]["server_members"]["Row"];
export type ChannelRow = Database["public"]["Tables"]["channels"]["Row"];
export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
export type GameCatalogRow =
  Database["public"]["Tables"]["game_catalog"]["Row"];
export type FriendshipRow = Database["public"]["Tables"]["friendships"]["Row"];
export type DirectChannelRow =
  Database["public"]["Tables"]["direct_channels"]["Row"];
export type DirectMessageRow =
  Database["public"]["Tables"]["direct_messages"]["Row"];
