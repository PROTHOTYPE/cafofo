import { create } from "zustand";
import type {
  ChannelRow,
  ChannelType,
  Json,
  MemberRole,
  ProfileRow,
  ServerRoleRow,
  ServerRow,
} from "../supabase/types";
import {
  getSupabaseClientOrThrow,
  loadPreferredPresenceStatus,
  useAuthStore,
} from "./useAuthStore";
import {
  AVATAR_MAX_BYTES,
  validateImageFile,
} from "../services/profileService";
import {
  onProfileRealtimeUpdate,
  onServerRealtimeInvalidate,
  onServerRowRealtimeUpdate,
  usePresenceStore,
} from "./usePresenceStore";

function toServerError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) {
      return new Error(msg);
    }
  }
  return new Error(String(err));
}

export interface ServerMemberWithProfile {
  server_id: string;
  user_id: string;
  role: MemberRole;
  role_id: string | null;
  custom_role?: ServerRoleRow | null;
  nickname: string | null;
  joined_at: string;
  profile: ProfileRow | null;
}

interface ServerState {
  servers: ServerRow[];
  activeServerId: string | null;
  channelsByServer: Record<string, ChannelRow[]>;
  activeChannelId: string | null;
  membersByServer: Record<string, ServerMemberWithProfile[]>;
  rolesByServer: Record<string, ServerRoleRow[]>;
  loading: boolean;
  error: string | null;

  loadServers: () => Promise<ServerRow[]>;
  createServer: (params: {
    name: string;
    description?: string;
  }) => Promise<ServerRow>;
  joinByInviteCode: (inviteCode: string) => Promise<ServerRow>;
  regenerateInviteCode: (serverId: string) => Promise<string>;
  updateServerIcon: (serverId: string, file: File) => Promise<ServerRow>;
  selectServer: (serverId: string) => Promise<void>;
  loadChannels: (serverId: string) => Promise<ChannelRow[]>;
  loadMembers: (serverId: string) => Promise<ServerMemberWithProfile[]>;
  loadRoles: (serverId: string) => Promise<ServerRoleRow[]>;
  createRole: (params: {
    serverId: string;
    name: string;
    color: string;
    position?: number;
    permissions?: Json;
  }) => Promise<ServerRoleRow>;
  updateRole: (params: {
    serverId: string;
    roleId: string;
    name?: string;
    color?: string;
    position?: number;
  }) => Promise<ServerRoleRow>;
  deleteRole: (params: {
    serverId: string;
    roleId: string;
  }) => Promise<void>;
  assignMemberRole: (params: {
    serverId: string;
    userId: string;
    roleId: string | null;
    systemRole?: MemberRole;
  }) => Promise<void>;
  createChannel: (params: {
    serverId: string;
    name: string;
    type: ChannelType;
    topic?: string;
  }) => Promise<ChannelRow>;
  renameChannel: (params: {
    serverId: string;
    channelId: string;
    name: string;
  }) => Promise<ChannelRow>;
  deleteChannel: (params: {
    serverId: string;
    channelId: string;
  }) => Promise<void>;
  leaveServer: (serverId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  kickMember: (params: { serverId: string; userId: string }) => Promise<void>;
  selectChannel: (channelId: string | null) => void;
  reset: () => Promise<void>;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: null,
  channelsByServer: {},
  activeChannelId: null,
  membersByServer: {},
  rolesByServer: {},
  loading: false,
  error: null,

  loadServers: async () => {
    const supabase = getSupabaseClientOrThrow();
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase
        .from("servers")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw toServerError(error);

      const servers = data ?? [];
      set({ servers });

      const currentActive = get().activeServerId;
      if (servers.length > 0 && (!currentActive || !servers.some((s) => s.id === currentActive))) {
        await get().selectServer(servers[0].id);
      } else if (servers.length === 0) {
        set({ activeServerId: null, activeChannelId: null });
      }
      return servers;
    } catch (err) {
      const resolved = toServerError(err);
      set({ error: resolved.message });
      throw resolved;
    } finally {
      set({ loading: false });
    }
  },

  createServer: async ({ name, description }) => {
    const supabase = getSupabaseClientOrThrow();
    const userId = useAuthStore.getState().user?.id;
    if (!userId) throw new Error("Usuário não autenticado.");

    const cleanName = name.trim();
    if (!cleanName) throw new Error("Nome do servidor é obrigatório.");

    set({ loading: true, error: null });
    try {
      const { data: server, error } = await supabase
        .from("servers")
        .insert({
          name: cleanName,
          description: description?.trim() || null,
          owner_id: userId,
        })
        .select("*")
        .single();

      if (error) throw toServerError(error);

      // Create default #geral (text) and Sala de Voz (voice) channels
      await supabase.from("channels").insert([
        {
          server_id: server.id,
          name: "geral",
          type: "text",
          position: 0,
        },
        {
          server_id: server.id,
          name: "Voz Principal",
          type: "voice",
          position: 1,
        },
      ]);

      set((prev) => ({
        servers: [...prev.servers.filter((s) => s.id !== server.id), server],
      }));

      await get().selectServer(server.id);
      return server;
    } catch (err) {
      const resolved = toServerError(err);
      set({ error: resolved.message });
      throw resolved;
    } finally {
      set({ loading: false });
    }
  },

  joinByInviteCode: async (inviteCode) => {
    const supabase = getSupabaseClientOrThrow();
    const code = inviteCode.trim().replace(/^#+/, "").trim().toLowerCase();
    if (!code) throw new Error("Informe um código de convite.");

    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.rpc("join_server_by_invite", {
        p_invite_code: code,
      });
      if (error) throw toServerError(error);

      const server = data as ServerRow;
      set((prev) => ({
        servers: prev.servers.some((s) => s.id === server.id)
          ? prev.servers
          : [...prev.servers, server],
      }));
      await get().selectServer(server.id);
      return server;
    } catch (err) {
      const resolved = toServerError(err);
      set({ error: resolved.message });
      throw resolved;
    } finally {
      set({ loading: false });
    }
  },

  regenerateInviteCode: async (serverId) => {
    const supabase = getSupabaseClientOrThrow();
    const { data, error } = await supabase.rpc("regenerate_server_invite", {
      p_server_id: serverId,
    });
    if (error) throw new Error(error.message);

    const newCode = String(data);
    set((prev) => ({
      servers: prev.servers.map((s) =>
        s.id === serverId ? { ...s, invite_code: newCode } : s,
      ),
    }));
    return newCode;
  },

  updateServerIcon: async (serverId, file) => {
    validateImageFile(file, AVATAR_MAX_BYTES, "Ícone do servidor");
    const supabase = getSupabaseClientOrThrow();

    const rawExt = file.name.split(".").pop()?.toLowerCase();
    const ext =
      rawExt && /^[a-z0-9]{2,5}$/.test(rawExt)
        ? rawExt
        : file.type === "image/png"
          ? "png"
          : file.type === "image/webp"
            ? "webp"
            : file.type === "image/gif"
              ? "gif"
              : "jpg";
    const filePath = `${serverId}/icon-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("server-icons")
      .upload(filePath, file, {
        contentType: file.type || "image/png",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Erro ao enviar ícone do servidor: ${uploadError.message}`);
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from("server-icons").getPublicUrl(filePath);

    const { data, error } = await supabase
      .from("servers")
      .update({ icon_url: publicUrl })
      .eq("id", serverId)
      .select("*")
      .single();

    if (error) {
      throw new Error(`Erro ao atualizar ícone do servidor: ${error.message}`);
    }

    set((prev) => ({
      servers: prev.servers.map((s) => (s.id === serverId ? data : s)),
    }));
    return data;
  },

  selectServer: async (serverId) => {
    set({ activeServerId: serverId, error: null });
    const [channels] = await Promise.all([
      get().loadChannels(serverId),
      get().loadRoles(serverId),
      get().loadMembers(serverId),
    ]);

    const firstText = channels.find((c) => c.type === "text") ?? channels[0] ?? null;
    set({ activeChannelId: firstText?.id ?? null });

    const userId = useAuthStore.getState().user?.id;
    const status =
      loadPreferredPresenceStatus() ??
      useAuthStore.getState().profile?.status ??
      "online";
    if (userId) {
      await usePresenceStore.getState().bindServerPresence(serverId, userId, status);
    }
  },

  loadChannels: async (serverId) => {
    const supabase = getSupabaseClientOrThrow();
    const { data, error } = await supabase
      .from("channels")
      .select("*")
      .eq("server_id", serverId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    const channels = data ?? [];

    set((prev) => ({
      channelsByServer: {
        ...prev.channelsByServer,
        [serverId]: channels,
      },
    }));
    return channels;
  },

  loadRoles: async (serverId) => {
    const supabase = getSupabaseClientOrThrow();
    const { data, error } = await supabase
      .from("server_roles")
      .select("*")
      .eq("server_id", serverId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    const roles = data ?? [];

    set((prev) => {
      const rolesMap = new Map(roles.map((r) => [r.id, r]));
      const existingMembers = prev.membersByServer[serverId];
      const updatedMembers = existingMembers
        ? existingMembers.map((m) => ({
            ...m,
            custom_role: m.role_id ? (rolesMap.get(m.role_id) ?? null) : null,
          }))
        : undefined;

      return {
        rolesByServer: {
          ...prev.rolesByServer,
          [serverId]: roles,
        },
        membersByServer: updatedMembers
          ? {
              ...prev.membersByServer,
              [serverId]: updatedMembers,
            }
          : prev.membersByServer,
      };
    });
    return roles;
  },

  createRole: async ({ serverId, name, color, position, permissions }) => {
    const supabase = getSupabaseClientOrThrow();
    const cleanName = name.trim().toUpperCase();
    if (!cleanName) throw new Error("Nome do cargo/tag é obrigatório.");
    const cleanColor = color.trim() || "#B91C1C";
    const existing = get().rolesByServer[serverId] ?? [];
    const nextPos = position ?? existing.length;

    const { data, error } = await supabase
      .from("server_roles")
      .insert({
        server_id: serverId,
        name: cleanName,
        color: cleanColor,
        position: nextPos,
        permissions: permissions ?? {},
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    set((prev) => {
      const list = [...(prev.rolesByServer[serverId] ?? []).filter((r) => r.id !== data.id), data];
      list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
      return {
        rolesByServer: {
          ...prev.rolesByServer,
          [serverId]: list,
        },
      };
    });
    return data;
  },

  updateRole: async ({ serverId, roleId, name, color, position }) => {
    const supabase = getSupabaseClientOrThrow();
    const patch: { name?: string; color?: string; position?: number } = {};
    if (name !== undefined) {
      const clean = name.trim().toUpperCase();
      if (!clean) throw new Error("Nome do cargo/tag é obrigatório.");
      patch.name = clean;
    }
    if (color !== undefined) patch.color = color.trim() || "#B91C1C";
    if (position !== undefined) patch.position = position;

    const { data, error } = await supabase
      .from("server_roles")
      .update(patch)
      .eq("id", roleId)
      .eq("server_id", serverId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    set((prev) => {
      const list = (prev.rolesByServer[serverId] ?? []).map((r) =>
        r.id === roleId ? data : r,
      );
      list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
      const members = (prev.membersByServer[serverId] ?? []).map((m) =>
        m.role_id === roleId ? { ...m, custom_role: data } : m,
      );
      return {
        rolesByServer: {
          ...prev.rolesByServer,
          [serverId]: list,
        },
        membersByServer: {
          ...prev.membersByServer,
          [serverId]: members,
        },
      };
    });
    return data;
  },

  deleteRole: async ({ serverId, roleId }) => {
    const supabase = getSupabaseClientOrThrow();
    const { error } = await supabase
      .from("server_roles")
      .delete()
      .eq("id", roleId)
      .eq("server_id", serverId);

    if (error) throw new Error(error.message);

    set((prev) => {
      const remaining = (prev.rolesByServer[serverId] ?? []).filter(
        (r) => r.id !== roleId,
      );
      const members = (prev.membersByServer[serverId] ?? []).map((m) =>
        m.role_id === roleId ? { ...m, role_id: null, custom_role: null } : m,
      );
      return {
        rolesByServer: {
          ...prev.rolesByServer,
          [serverId]: remaining,
        },
        membersByServer: {
          ...prev.membersByServer,
          [serverId]: members,
        },
      };
    });
  },

  assignMemberRole: async ({ serverId, userId, roleId, systemRole }) => {
    const supabase = getSupabaseClientOrThrow();
    const updatePayload: { role_id: string | null; role?: MemberRole } = {
      role_id: roleId,
    };
    if (systemRole) {
      updatePayload.role = systemRole;
    }

    const { error } = await supabase
      .from("server_members")
      .update(updatePayload)
      .eq("server_id", serverId)
      .eq("user_id", userId);

    if (error) throw new Error(error.message);

    set((prev) => {
      const roles = prev.rolesByServer[serverId] ?? [];
      const matchedRole = roleId
        ? (roles.find((r) => r.id === roleId) ?? null)
        : null;
      const members = (prev.membersByServer[serverId] ?? []).map((m) =>
        m.user_id === userId
          ? {
              ...m,
              role_id: roleId,
              custom_role: matchedRole,
              role: systemRole ?? m.role,
            }
          : m,
      );
      return {
        membersByServer: {
          ...prev.membersByServer,
          [serverId]: members,
        },
      };
    });
  },

  loadMembers: async (serverId) => {
    const supabase = getSupabaseClientOrThrow();
    const { data, error } = await supabase
      .from("server_members")
      .select(
        "server_id, user_id, role, role_id, nickname, joined_at, profile:profiles(*), custom_role:server_roles(*)",
      )
      .eq("server_id", serverId)
      .order("joined_at", { ascending: true });

    if (error) throw new Error(error.message);

    const knownRoles = get().rolesByServer[serverId] ?? [];
    const rolesById = new Map(knownRoles.map((r) => [r.id, r]));

    const normalized: ServerMemberWithProfile[] = (data ?? []).map((row) => {
      const rawProfile = (row as { profile?: ProfileRow | ProfileRow[] | null }).profile;
      const profile = Array.isArray(rawProfile) ? rawProfile[0] ?? null : rawProfile ?? null;
      const rawCustomRole = (
        row as { custom_role?: ServerRoleRow | ServerRoleRow[] | null }
      ).custom_role;
      const joinedRole = Array.isArray(rawCustomRole)
        ? (rawCustomRole[0] ?? null)
        : (rawCustomRole ?? null);
      const roleId = row.role_id ?? null;
      return {
        server_id: row.server_id,
        user_id: row.user_id,
        role: row.role,
        role_id: roleId,
        custom_role: joinedRole ?? (roleId ? (rolesById.get(roleId) ?? null) : null),
        nickname: row.nickname,
        joined_at: row.joined_at,
        profile,
      };
    });

    set((prev) => ({
      membersByServer: {
        ...prev.membersByServer,
        [serverId]: normalized,
      },
    }));
    return normalized;
  },

  createChannel: async ({ serverId, name, type, topic }) => {
    const supabase = getSupabaseClientOrThrow();
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Nome do canal é obrigatório.");

    const existing = get().channelsByServer[serverId] ?? [];
    const nextPos = existing.length;

    const { data, error } = await supabase
      .from("channels")
      .insert({
        server_id: serverId,
        name: cleanName,
        type,
        topic: topic?.trim() || null,
        position: nextPos,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    set((prev) => ({
      channelsByServer: {
        ...prev.channelsByServer,
        [serverId]: [...(prev.channelsByServer[serverId] ?? []), data],
      },
      activeChannelId: type === "text" ? data.id : prev.activeChannelId,
    }));
    return data;
  },

  renameChannel: async ({ serverId, channelId, name }) => {
    const supabase = getSupabaseClientOrThrow();
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Nome do canal é obrigatório.");

    const { data, error } = await supabase
      .from("channels")
      .update({ name: cleanName })
      .eq("id", channelId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    set((prev) => ({
      channelsByServer: {
        ...prev.channelsByServer,
        [serverId]: (prev.channelsByServer[serverId] ?? []).map((c) =>
          c.id === channelId ? data : c,
        ),
      },
    }));
    return data;
  },

  deleteChannel: async ({ serverId, channelId }) => {
    const supabase = getSupabaseClientOrThrow();
    const existing = get().channelsByServer[serverId] ?? [];
    const target = existing.find((c) => c.id === channelId);

    if (target?.type === "text") {
      const remainingText = existing.filter(
        (c) => c.type === "text" && c.id !== channelId,
      );
      if (remainingText.length === 0) {
        throw new Error(
          "Não é possível excluir o último canal de texto do servidor.",
        );
      }
    }

    const { error } = await supabase
      .from("channels")
      .delete()
      .eq("id", channelId);
    if (error) throw new Error(error.message);

    const remaining = existing.filter((c) => c.id !== channelId);
    const nextActive =
      get().activeChannelId === channelId
        ? (remaining.find((c) => c.type === "text")?.id ??
            remaining[0]?.id ??
            null)
        : get().activeChannelId;

    set((prev) => ({
      channelsByServer: {
        ...prev.channelsByServer,
        [serverId]: remaining,
      },
      activeChannelId: nextActive,
    }));
  },

  leaveServer: async (serverId) => {
    const supabase = getSupabaseClientOrThrow();
    const userId = useAuthStore.getState().user?.id;
    if (!userId) throw new Error("Usuário não autenticado.");

    const target = get().servers.find((s) => s.id === serverId);
    if (target?.owner_id === userId) {
      throw new Error(
        "O dono não pode sair do próprio servidor. Use 'Excluir Servidor'.",
      );
    }

    const { error } = await supabase
      .from("server_members")
      .delete()
      .eq("server_id", serverId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);

    const remainingServers = get().servers.filter((s) => s.id !== serverId);
    const wasActive = get().activeServerId === serverId;

    set((prev) => {
      const nextChannels = { ...prev.channelsByServer };
      const nextMembers = { ...prev.membersByServer };
      delete nextChannels[serverId];
      delete nextMembers[serverId];
      return {
        servers: remainingServers,
        channelsByServer: nextChannels,
        membersByServer: nextMembers,
        activeServerId: wasActive
          ? (remainingServers[0]?.id ?? null)
          : prev.activeServerId,
        activeChannelId: wasActive ? null : prev.activeChannelId,
      };
    });

    if (wasActive) {
      if (remainingServers.length > 0) {
        await get().selectServer(remainingServers[0].id);
      } else {
        await usePresenceStore.getState().unbindServerPresence();
      }
    }
  },

  deleteServer: async (serverId) => {
    const supabase = getSupabaseClientOrThrow();
    const { error } = await supabase
      .from("servers")
      .delete()
      .eq("id", serverId);
    if (error) throw new Error(error.message);

    const remainingServers = get().servers.filter((s) => s.id !== serverId);
    const wasActive = get().activeServerId === serverId;

    set((prev) => {
      const nextChannels = { ...prev.channelsByServer };
      const nextMembers = { ...prev.membersByServer };
      delete nextChannels[serverId];
      delete nextMembers[serverId];
      return {
        servers: remainingServers,
        channelsByServer: nextChannels,
        membersByServer: nextMembers,
        activeServerId: wasActive
          ? (remainingServers[0]?.id ?? null)
          : prev.activeServerId,
        activeChannelId: wasActive ? null : prev.activeChannelId,
      };
    });

    if (wasActive) {
      if (remainingServers.length > 0) {
        await get().selectServer(remainingServers[0].id);
      } else {
        await usePresenceStore.getState().unbindServerPresence();
      }
    }
  },

  kickMember: async ({ serverId, userId }) => {
    const supabase = getSupabaseClientOrThrow();
    const { error } = await supabase
      .from("server_members")
      .delete()
      .eq("server_id", serverId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);

    set((prev) => ({
      membersByServer: {
        ...prev.membersByServer,
        [serverId]: (prev.membersByServer[serverId] ?? []).filter(
          (m) => m.user_id !== userId,
        ),
      },
    }));
  },

  selectChannel: (channelId) => {
    set({ activeChannelId: channelId });
  },

  reset: async () => {
    await usePresenceStore.getState().unbindServerPresence();
    set({
      servers: [],
      activeServerId: null,
      channelsByServer: {},
      activeChannelId: null,
      membersByServer: {},
      rolesByServer: {},
      loading: false,
      error: null,
    });
  },
}));

onServerRealtimeInvalidate((serverId, kind) => {
  const store = useServerStore.getState();
  if (kind === "roles") {
    void store.loadRoles(serverId).catch(() => {});
  } else if (kind === "members") {
    void store.loadMembers(serverId).catch(() => {});
  } else if (kind === "channels") {
    void store.loadChannels(serverId).catch(() => {});
  }
});

onServerRowRealtimeUpdate((updatedServer) => {
  useServerStore.setState((prev) => {
    const exists = prev.servers.some((s) => s.id === updatedServer.id);
    if (!exists) return prev;
    return {
      servers: prev.servers.map((s) =>
        s.id === updatedServer.id ? { ...s, ...updatedServer } : s,
      ),
    };
  });
});

onProfileRealtimeUpdate((updatedProfile) => {
  useServerStore.setState((prev) => {
    let changed = false;
    const nextMembersByServer: Record<string, ServerMemberWithProfile[]> = {};
    for (const [serverId, list] of Object.entries(prev.membersByServer)) {
      let listChanged = false;
      const nextList = list.map((m) => {
        if (m.user_id !== updatedProfile.id) return m;
        listChanged = true;
        return {
          ...m,
          profile: updatedProfile,
        };
      });
      nextMembersByServer[serverId] = listChanged ? nextList : list;
      if (listChanged) changed = true;
    }
    return changed ? { membersByServer: nextMembersByServer } : prev;
  });
});
