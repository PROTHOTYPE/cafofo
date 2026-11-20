import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useServerStore, type ServerRoleRow } from "@cafofo/core-logic";
import { Plus, Tag, Trash2, X } from "lucide-react";
import { Modal } from "./Modal";

const EMPTY_ROLES: ServerRoleRow[] = [];

const ROLE_PRESETS: Array<{ name: string; color: string }> = [
  { name: "ADMIN", color: "#EF4444" },
  { name: "MOD", color: "#F59E0B" },
  { name: "STREAMER", color: "#A855F7" },
  { name: "VIP", color: "#06B6D4" },
  { name: "TRYHARD", color: "#10B981" },
  { name: "MEMBRO", color: "#71717A" },
];

const ROLE_COLOR_SWATCHES = [
  "#EF4444",
  "#B91C1C",
  "#F59E0B",
  "#10B981",
  "#06B6D4",
  "#3B82F6",
  "#A855F7",
  "#EC4899",
  "#71717A",
] as const;

export interface ServerRolesManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string | null;
  serverName?: string | null;
}

export function ServerRolesManagerDialog({
  open,
  onOpenChange,
  serverId,
  serverName,
}: ServerRolesManagerDialogProps) {
  const roles = useServerStore((s) =>
    serverId ? (s.rolesByServer[serverId] ?? EMPTY_ROLES) : EMPTY_ROLES,
  );
  const createRole = useServerStore((s) => s.createRole);
  const updateRole = useServerStore((s) => s.updateRole);
  const deleteRole = useServerStore((s) => s.deleteRole);

  const [roleName, setRoleName] = useState("");
  const [roleColor, setRoleColor] = useState("#B91C1C");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleCreateRole = async (e: FormEvent) => {
    e.preventDefault();
    if (!serverId || !roleName.trim()) return;
    setRoleError(null);
    setBusy(true);
    try {
      await createRole({
        serverId,
        name: roleName.trim().toUpperCase(),
        color: roleColor,
      });
      setRoleName("");
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      overlayZIndexClass="z-[75]"
      contentClassName="w-[92vw] max-w-lg rounded-2xl bg-[#101014] hairline-box shadow-2xl overflow-hidden flex flex-col max-h-[85dvh]"
    >
      <div className="px-5 py-4 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-[#16161C] border border-[#B91C1C]/60 flex items-center justify-center shrink-0">
            <Tag className="w-4 h-4 text-[#EF4444]" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA] truncate">
              Cargos & Tags — {serverName ?? "Servidor"}
            </Dialog.Title>
            <Dialog.Description className="text-[11px] text-[#A1A1AA] truncate">
              Crie tags coloridas para agrupar membros na barra lateral
            </Dialog.Description>
          </div>
        </div>

        <Dialog.Close asChild>
          <button
            type="button"
            className="p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
          >
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </Dialog.Close>
      </div>

      <div className="p-5 overflow-y-auto space-y-4 text-xs">
        {/* Formulário de Criação de Tag/Cargo */}
        <form
          onSubmit={handleCreateRole}
          className="p-3.5 rounded-xl bg-[#09090B] hairline-box space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-wider text-[#A1A1AA]">
              Nova Tag / Cargo
            </span>
            <span
              className="px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold uppercase tracking-wide"
              style={{
                backgroundColor: `${roleColor}24`,
                color: roleColor,
                border: `1px solid ${roleColor}66`,
              }}
            >
              {roleName.trim().toUpperCase() || "PREVIEW"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              maxLength={24}
              placeholder="Ex: ADMIN, MOD, STREAMER..."
              value={roleName}
              onChange={(e) => setRoleName(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[#101014] hairline-box font-mono text-xs text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
            />
            <input
              type="color"
              value={roleColor}
              onChange={(e) => setRoleColor(e.target.value)}
              className="w-9 h-9 rounded-lg cursor-pointer bg-transparent border-0 shrink-0"
              title="Cor da Tag"
            />
            <button
              type="submit"
              disabled={busy || !roleName.trim()}
              className="min-h-[36px] px-3.5 py-2 rounded-lg btn-crimson-vivid disabled:opacity-40 text-xs font-medium text-[#FAFAFA] flex items-center gap-1.5 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Criar</span>
            </button>
          </div>

          {/* Presets Rápidos */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {ROLE_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => {
                    setRoleName(preset.name);
                    setRoleColor(preset.color);
                  }}
                  className="px-2 py-0.5 rounded-md bg-[#16161C] hover:bg-[#1E1E26] hairline-box font-mono text-[10px] flex items-center gap-1.5 text-[#FAFAFA] transition-colors"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: preset.color }}
                  />
                  <span>{preset.name}</span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 pt-1">
              {ROLE_COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setRoleColor(swatch)}
                  className={`w-5 h-5 rounded-full transition-transform ${
                    roleColor.toLowerCase() === swatch.toLowerCase()
                      ? "scale-110 ring-2 ring-white"
                      : "opacity-80 hover:opacity-100"
                  }`}
                  style={{ backgroundColor: swatch }}
                  aria-label={`Cor ${swatch}`}
                />
              ))}
            </div>
          </div>

          {roleError && (
            <p className="text-[11px] font-mono text-[#F87171]">{roleError}</p>
          )}
        </form>

        {/* Lista de Cargos / Tags do Servidor */}
        <div className="space-y-2">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-[#71717A] px-1">
            <span>Cargos Ativos ({roles.length})</span>
            <span>Cor & Ordem</span>
          </div>

          {roles.length === 0 ? (
            <p className="text-xs text-[#71717A] text-center py-4">
              Nenhum cargo customizado cadastrado neste servidor.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {roles.map((r) => (
                <li
                  key={r.id}
                  className="px-3 py-2 rounded-xl bg-[#09090B] hairline-box flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="color"
                      value={r.color}
                      onChange={(e) => {
                        if (!serverId) return;
                        void updateRole({
                          serverId,
                          roleId: r.id,
                          color: e.target.value,
                        }).catch(() => {});
                      }}
                      className="w-6 h-6 rounded cursor-pointer bg-transparent border-0 shrink-0"
                      title="Alterar cor do cargo"
                    />
                    <span
                      className="px-2 py-0.5 rounded-full font-mono text-[11px] font-semibold uppercase tracking-wide truncate"
                      style={{
                        backgroundColor: `${r.color}22`,
                        color: r.color,
                        border: `1px solid ${r.color}55`,
                      }}
                    >
                      {r.name}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (!serverId) return;
                      void deleteRole({
                        serverId,
                        roleId: r.id,
                      }).catch((err) =>
                        setRoleError(
                          err instanceof Error ? err.message : String(err),
                        ),
                      );
                    }}
                    className="p-1.5 rounded-lg hover:bg-[#1E1E26] text-[#F87171] transition-colors shrink-0"
                    title="Excluir cargo"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-[#71717A] pt-1">
            Dica: clique com o botão direito em qualquer membro na lista lateral para atribuir ou trocar sua tag/cargo.
          </p>
        </div>
      </div>
    </Modal>
  );
}
