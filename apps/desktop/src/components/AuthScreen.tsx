import { useState, type FormEvent } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useAuthStore } from "@cafofo/core-logic";
import {
  ArrowRight,
  Lock,
  Mail,
  MonitorUp,
  Radio,
  ShieldCheck,
  Sparkles,
  User,
} from "lucide-react";

const DEMO_EQ_BARS = [38, 72, 94, 58, 84, 45, 90, 64, 42, 78, 52, 34];

export function AuthScreen() {
  const signIn = useAuthStore((s) => s.signIn);
  const signUp = useAuthStore((s) => s.signUp);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else {
        await signUp({ email, password, username, displayName });
        setNotice(
          "Cadastro enviado. Caso a confirmação de e-mail esteja ativa no Supabase, verifique sua caixa de entrada.",
        );
      }
    } catch {
      // Erro já exposto via useAuthStore.error
    }
  };

  return (
    <div className="min-h-[100dvh] w-full max-w-full grid grid-cols-1 lg:grid-cols-2 bg-[#09090B] text-[#FAFAFA] overflow-x-hidden overflow-y-auto pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] select-none animate-cafofo-boot">
      {/* Painel esquerdo com preview e destaque visual */}
      <div className="hidden lg:flex relative flex-col justify-between p-10 ruby-refraction-canvas hairline-r overflow-hidden">
        {/* Gradiente Radial Pulsante (@keyframes cyber-pulse) */}
        <div
          className="absolute -top-24 -left-24 w-[480px] h-[480px] rounded-full pointer-events-none animate-cyber-pulse"
          style={{
            background:
              "radial-gradient(circle, rgba(185, 28, 28, 0.34) 0%, rgba(127, 29, 29, 0.12) 45%, transparent 72%)",
          }}
        />
        <div
          className="absolute -bottom-28 -right-20 w-[440px] h-[440px] rounded-full pointer-events-none animate-cyber-pulse"
          style={{
            animationDelay: "2.4s",
            background:
              "radial-gradient(circle, rgba(239, 68, 68, 0.22) 0%, rgba(185, 28, 28, 0.08) 50%, transparent 72%)",
          }}
        />

        <div className="absolute inset-0 architectural-grid-overlay pointer-events-none opacity-60" />

        {/* Linhas de Energia & Partículas de Telemetria em SVG */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none opacity-35"
          viewBox="0 0 800 900"
          fill="none"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="cafofo-energy-line"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#B91C1C" stopOpacity="0" />
              <stop offset="50%" stopColor="#EF4444" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#B91C1C" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M -40 210 Q 220 140, 420 260 T 840 190"
            stroke="url(#cafofo-energy-line)"
            strokeWidth="1.5"
            strokeDasharray="8 6"
          />
          <path
            d="M -20 640 Q 280 540, 510 670 T 840 590"
            stroke="url(#cafofo-energy-line)"
            strokeWidth="1.2"
          />
          <circle cx="195" cy="196" r="3" fill="#EF4444" opacity="0.8" />
          <circle cx="420" cy="260" r="3.5" fill="#B91C1C" opacity="0.9" />
          <circle cx="645" cy="215" r="2.5" fill="#F87171" opacity="0.75" />
          <circle cx="290" cy="602" r="3" fill="#EF4444" opacity="0.7" />
          <circle cx="510" cy="670" r="3.5" fill="#B91C1C" opacity="0.85" />
        </svg>

        {/* Marca Superior */}
        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/logo-icon.png"
              alt="Cafofo"
              className="w-10 h-10 rounded-xl object-cover shadow-crimson-glow border border-[#EF4444]/40 animate-radar-pulse-crimson"
            />
            <div>
              <span className="text-sm font-semibold tracking-tight block">
                CAFOFO
              </span>
              <span className="text-[11px] font-mono text-[#A1A1AA] block">
                HIGH-CRAFT VOICE & STREAMING
              </span>
            </div>
          </div>

          <span className="px-2.5 py-1 rounded-full bg-[#7F1D1D] border border-[#EF4444] text-[11px] font-mono font-medium tracking-wider text-white flex items-center gap-1.5 shadow-[0_0_20px_rgba(185,28,28,0.35)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-pulse" />
            OPUS 48KHZ NATIVO
          </span>
        </div>

        {/* Card de preview da sala */}
        <div className="relative z-10 my-auto max-w-md mx-auto w-full space-y-6">
          <div className="rounded-2xl backdrop-blur-md bg-[#101014]/80 border border-white/[0.08] shadow-[0_0_30px_rgba(185,28,28,0.15)] p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-xl bg-[#16161C] border border-[#B91C1C]/60 flex items-center justify-center text-sm font-bold text-[#FAFAFA] animate-radar-pulse-crimson">
                  CF
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-[#FAFAFA]">
                      Sala Principal • Squad
                    </h2>
                  </div>
                  <p className="text-xs text-[#A1A1AA] font-mono mt-0.5">
                    WASAPI Process Loopback • RNNoise DSP
                  </p>
                </div>
              </div>
              <span className="die-cut-sticker bg-[#B91C1C] text-white">
                <Sparkles className="w-3 h-3" strokeWidth={1.75} />
                ZERO BLOAT
              </span>
            </div>

            {/* Medidor de Voz em Barras Verticais */}
            <div className="rounded-xl bg-[#09090B]/90 hairline-box p-4 space-y-3">
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-[#A1A1AA] flex items-center gap-1.5">
                  <Radio
                    className="w-3.5 h-3.5 text-[#EF4444] animate-pulse"
                    strokeWidth={1.5}
                  />
                  VOICE TELEMETRY
                </span>
                <span className="text-[#FAFAFA]">14 ms • 60 FPS • 64 kbps</span>
              </div>
              <div className="h-12 flex items-end gap-1.5 pt-2">
                {DEMO_EQ_BARS.map((height, idx) => (
                  <div
                    key={idx}
                    className="flex-1 rounded-t-sm transition-all duration-300"
                    style={{
                      height: `${height}%`,
                      backgroundColor:
                        height > 70
                          ? "#B91C1C"
                          : height > 50
                            ? "rgba(185, 28, 28, 0.55)"
                            : "rgba(255, 255, 255, 0.16)",
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Pilares Técnicos */}
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div className="p-3 rounded-xl backdrop-blur-md bg-[#16161C]/80 border border-white/[0.08] space-y-1">
                <MonitorUp
                  className="w-4 h-4 text-[#EF4444]"
                  strokeWidth={1.5}
                />
                <div className="font-medium text-[#FAFAFA]">
                  Múltiplas Telas
                </div>
                <div className="text-[11px] text-[#71717A]">
                  Captura isolada WGC com áudio por processo.
                </div>
              </div>
              <div className="p-3 rounded-xl backdrop-blur-md bg-[#16161C]/80 border border-white/[0.08] space-y-1">
                <ShieldCheck
                  className="w-4 h-4 text-[#EF4444]"
                  strokeWidth={1.5}
                />
                <div className="font-medium text-[#FAFAFA]">
                  100% Gratuito
                </div>
                <div className="text-[11px] text-[#71717A]">
                  Banner, som de entrada e cores livres no perfil.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Rodapé */}
        <div className="relative z-10 flex items-center justify-between text-xs text-[#A1A1AA] font-mono">
          <span>OBSIDIAN MATTE #09090B</span>
          <span>DEEP CRIMSON #B91C1C</span>
        </div>
      </div>

      {/* Metade Direita (50%): Formulário Minimalista com Card Scoped Glass */}
      <div className="flex flex-col justify-center items-center px-5 py-8 sm:p-8 lg:p-16 bg-[#09090B]">
        <div className="w-full max-w-md rounded-2xl backdrop-blur-md bg-[#101014]/80 border border-white/[0.08] shadow-[0_0_30px_rgba(185,28,28,0.15)] p-6 sm:p-8 space-y-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#16161C] hairline-box text-[11px] font-mono text-[#A1A1AA]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#B91C1C] animate-pulse" />
              ACESSO AO CAFOFO
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#FAFAFA]">
              {mode === "login"
                ? "Bem-vindo de volta ao QG"
                : "Crie sua identidade no Cafofo"}
            </h1>
            <p className="text-xs text-[#A1A1AA] leading-relaxed">
              {mode === "login"
                ? "Entre com suas credenciais para conectar às salas de voz e transmissões do seu grupo."
                : "Configure seu perfil com cores personalizadas, banner e som de entrada sem travas."}
            </p>
          </div>

          <Tabs.Root
            value={mode}
            onValueChange={(v) => {
              setMode(v as "login" | "signup");
              setNotice(null);
            }}
            className="space-y-5"
          >
            <Tabs.List
              aria-label="Modo de autenticação"
              className="grid grid-cols-2 p-1 rounded-xl bg-[#09090B] hairline-box text-xs font-medium"
            >
              <Tabs.Trigger
                value="login"
                className="py-2 rounded-lg transition-all data-[state=active]:bg-[#16161C] data-[state=active]:text-[#FAFAFA] data-[state=active]:shadow-sm text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                Entrar
              </Tabs.Trigger>
              <Tabs.Trigger
                value="signup"
                className="py-2 rounded-lg transition-all data-[state=active]:bg-[#16161C] data-[state=active]:text-[#FAFAFA] data-[state=active]:shadow-sm text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                Criar Conta
              </Tabs.Trigger>
            </Tabs.List>

            <form onSubmit={handleSubmit} className="space-y-4">
              <Tabs.Content
                value="signup"
                className="space-y-4 focus:outline-none animate-cyber-slide"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-[#A1A1AA]">
                      Username
                    </span>
                    <div className="relative">
                      <User
                        className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2"
                        strokeWidth={1.5}
                      />
                      <input
                        type="text"
                        required={mode === "signup"}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="pedro"
                        className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-[#09090B] hairline-box text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C] transition-colors font-mono"
                      />
                    </div>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-[#A1A1AA]">
                      Nome de Exibição
                    </span>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Pedro"
                      className="w-full px-3 py-2.5 rounded-xl bg-[#09090B] hairline-box text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C] transition-colors"
                    />
                  </label>
                </div>
              </Tabs.Content>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#A1A1AA]">
                  E-mail
                </span>
                <div className="relative">
                  <Mail
                    className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2"
                    strokeWidth={1.5}
                  />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@cafofo.gg"
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-[#09090B] hairline-box text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C] transition-colors"
                  />
                </div>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#A1A1AA]">
                  Senha
                </span>
                <div className="relative">
                  <Lock
                    className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2"
                    strokeWidth={1.5}
                  />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-[#09090B] hairline-box text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C] transition-colors"
                  />
                </div>
              </label>

              {error && (
                <div className="p-3 rounded-xl bg-[#1E1E26] border border-[#F87171]/30 text-xs text-[#F87171]">
                  {error}
                </div>
              )}

              {notice && (
                <div className="p-3 rounded-xl bg-[#16161C] hairline-box text-xs text-emerald-400">
                  {notice}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-xl btn-crimson-vivid text-[#FAFAFA] font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <span>
                  {loading
                    ? "Sincronizando..."
                    : mode === "login"
                      ? "Entrar no Cafofo"
                      : "Criar Identidade"}
                </span>
                <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </form>
          </Tabs.Root>
        </div>
      </div>
    </div>
  );
}
