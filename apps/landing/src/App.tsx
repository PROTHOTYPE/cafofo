import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Cpu,
  Disc3,
  Download,
  Gamepad2,
  Globe,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Volume2,
} from "lucide-react";
import { AppPreviewMockup } from "./components/AppPreviewMockup";
import { BrandMark } from "./components/BrandMark";

const RELEASE_MANIFEST_URL =
  "https://pub-88d3470004c540019838c149f440043a.r2.dev/latest.json";
const WEB_APP_URL = "https://cafofo.pages.dev";

interface LatestReleaseManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  size?: number;
  platforms?: {
    "windows-x86_64"?: {
      url: string;
      signature?: string;
    };
  };
}

const FALLBACK_RELEASE: LatestReleaseManifest = {
  version: "0.1.0",
  notes:
    "Primeira versão oficial do Cafofo Desktop para Windows com voz RNNoise, palco de transmissões 16:9, bot de música sincronizado e auto-update.",
  size: 12_373_196,
  platforms: {
    "windows-x86_64": {
      url: "https://pub-88d3470004c540019838c149f440043a.r2.dev/releases/v0.1.0/Cafofo_0.1.0_x64-setup.exe",
    },
  },
};

function formatDatePtBr(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatSizeMb(bytes?: number): string {
  if (!bytes || bytes <= 0) return "~12 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FEATURES = [
  {
    icon: Volume2,
    title: "Voz limpa com RNNoise",
    description:
      "Supressão de ruído neural direto no cliente e áudio de baixa latência via LiveKit em São Paulo (GRU). Teclado mecânico e ventilador somem da call.",
  },
  {
    icon: MonitorUp,
    title: "Palco de transmissões 16:9",
    description:
      "Compartilhe a janela do jogo ou a tela inteira em alta definição, com foco fixado no palco sem sobrepor os cartões da galera.",
  },
  {
    icon: Disc3,
    title: "Bot de música na sala",
    description:
      "Busque ou cole links do YouTube, avance no tempo da faixa e ouça sincronizado com todo mundo da sala de voz com controle individual de volume.",
  },
  {
    icon: Sparkles,
    title: "Identidade que é sua",
    description:
      "Banner recortável, molduras animadas de avatar, temas de cartão, stickers personalizados e som de entrada de até 3 segundos quando você cola na call.",
  },
  {
    icon: Gamepad2,
    title: "Game Detector nativo",
    description:
      "O app desktop detecta automaticamente o jogo aberto no Windows e atualiza seu status em tempo real para os amigos.",
  },
  {
    icon: RefreshCw,
    title: "Atualizações em 1 clique",
    description:
      "Cada versão nova é assinada criptograficamente e baixada direto dentro do Cafofo. Sem precisar caçar instalador toda semana.",
  },
];

export function App() {
  const [release, setRelease] = useState<LatestReleaseManifest>(FALLBACK_RELEASE);

  useEffect(() => {
    let active = true;
    fetch(RELEASE_MANIFEST_URL, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: LatestReleaseManifest | null) => {
        if (active && data?.version && data.platforms?.["windows-x86_64"]?.url) {
          setRelease(data);
        }
      })
      .catch(() => {
        // Mantém fallback silenciosamente
      });
    return () => {
      active = false;
    };
  }, []);

  const downloadUrl =
    release.platforms?.["windows-x86_64"]?.url ??
    FALLBACK_RELEASE.platforms!["windows-x86_64"]!.url;
  const pubDateFormatted = formatDatePtBr(release.pub_date);
  const installerSize = formatSizeMb(release.size);

  return (
    <div className="min-h-screen bg-[#09090B] text-[#FAFAFA] relative overflow-x-hidden">
      {/* Glow ambiental sutil no topo */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] obsidian-grid"
        style={{
          maskImage:
            "radial-gradient(ellipse 75% 65% at 50% 0%, black 35%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 75% 65% at 50% 0%, black 35%, transparent 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[680px] h-[360px] rounded-full bg-[#B91C1C]/20 blur-[130px]"
      />

      {/* Navbar */}
      <header className="sticky top-0 z-40 scoped-glass border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between gap-4">
          <a href="#" className="flex items-center gap-2.5 group">
            <BrandMark size="sm" />
            <span className="font-semibold tracking-tight text-base">
              Cafofo
            </span>
            <span className="hidden sm:inline-block px-2 py-0.5 rounded-md bg-[#16161C] hairline-box font-mono text-[10px] text-[#A1A1AA]">
              v{release.version}
            </span>
          </a>

          <nav className="hidden md:flex items-center gap-7 text-xs text-[#A1A1AA]">
            <a href="#recursos" className="hover:text-[#FAFAFA] transition-colors">
              Recursos
            </a>
            <a href="#versao" className="hover:text-[#FAFAFA] transition-colors">
              Notas da versão
            </a>
            <a href="#instalacao" className="hover:text-[#FAFAFA] transition-colors">
              Instalação
            </a>
          </nav>

          <div className="flex items-center gap-2.5">
            <a
              href={WEB_APP_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA] transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Versão Web</span>
            </a>
            <a
              href={downloadUrl}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA] transition-all"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Baixar</span>
            </a>
          </div>
        </div>
      </header>

      <main className="relative z-10">
        {/* Hero */}
        <section className="max-w-6xl mx-auto px-5 pt-16 pb-14 md:pt-24 md:pb-20">
          <div className="max-w-3xl mx-auto text-center space-y-6">
            <div className="inline-flex flex-wrap items-center justify-center gap-2 px-3 py-1 rounded-full bg-[#101014] hairline-box font-mono text-[11px] text-[#A1A1AA]">
              <span className="w-2 h-2 rounded-full bg-[#EF4444]" />
              <span>WINDOWS 10 / 11 (x64)</span>
              <span className="text-[#3F3F46]">•</span>
              <span className="text-[#FAFAFA]">v{release.version}</span>
              <span className="text-[#3F3F46]">•</span>
              <span>{installerSize}</span>
            </div>

            <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.08] text-[#FAFAFA]">
              Seu espaço de voz, tela e música.{" "}
              <span className="text-[#EF4444]">Leve de verdade.</span>
            </h1>

            <p className="text-base sm:text-lg text-[#A1A1AA] max-w-2xl mx-auto leading-relaxed">
              O Cafofo roda nativo em Rust + Tauri para não comer seu FPS nem sua
              RAM enquanto você joga. Entre na call, compartilhe a tela em 16:9 e
              solte uma música sincronizada com a sala.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <a
                href={downloadUrl}
                className="w-full sm:w-auto min-h-[48px] px-6 py-3 rounded-2xl btn-crimson-vivid text-sm font-semibold text-[#FAFAFA] inline-flex items-center justify-center gap-2.5 transition-all"
              >
                <Download className="w-4 h-4" strokeWidth={2} />
                <span>Baixar para Windows (.exe)</span>
              </a>

              <a
                href={WEB_APP_URL}
                target="_blank"
                rel="noreferrer"
                className="w-full sm:w-auto min-h-[48px] px-6 py-3 rounded-2xl bg-[#101014] hover:bg-[#16161C] hairline-box text-sm font-medium text-[#FAFAFA] inline-flex items-center justify-center gap-2 transition-colors"
              >
                <Globe className="w-4 h-4 text-[#A1A1AA]" />
                <span>Abrir no Navegador</span>
                <ArrowUpRight className="w-4 h-4 text-[#71717A]" />
              </a>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pt-2 font-mono text-[11px] text-[#71717A]">
              <span className="inline-flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-[#EF4444]" />
                Instalador de {installerSize}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-[#EF4444]" />
                Atualizações assinadas
              </span>
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 text-[#EF4444]" />
                Auto-update nativo
              </span>
            </div>
          </div>

          {/* Mockup fiel do app */}
          <div className="mt-14 md:mt-16">
            <AppPreviewMockup />
          </div>
        </section>

        {/* Recursos */}
        <section
          id="recursos"
          className="max-w-6xl mx-auto px-5 py-16 border-t border-white/[0.06]"
        >
          <div className="max-w-2xl mb-10 space-y-2">
            <p className="font-mono text-xs uppercase tracking-widest text-[#EF4444]">
              Feito para jogar junto
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Tudo o que a call precisa, sem peso morto.
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.title}
                  className="rounded-2xl bg-[#101014] hairline-box p-5 space-y-3 hover:border-[#B91C1C]/40 transition-colors"
                >
                  <div className="w-9 h-9 rounded-xl bg-[#B91C1C]/15 border border-[#B91C1C]/35 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-[#EF4444]" strokeWidth={1.75} />
                  </div>
                  <h3 className="text-sm font-semibold text-[#FAFAFA]">
                    {item.title}
                  </h3>
                  <p className="text-xs text-[#A1A1AA] leading-relaxed">
                    {item.description}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Notas da Versão + Guia Rápido de Instalação */}
        <section
          id="versao"
          className="max-w-6xl mx-auto px-5 py-16 border-t border-white/[0.06]"
        >
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Release Notes dinâmicas do R2 */}
            <div className="lg:col-span-7 rounded-2xl bg-[#101014] hairline-box p-6 flex flex-col justify-between gap-5">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs uppercase tracking-wider text-[#EF4444]">
                    Última versão disponível
                  </span>
                  <div className="flex items-center gap-2 font-mono text-[11px] text-[#A1A1AA]">
                    <span className="px-2 py-0.5 rounded-md bg-[#16161C] hairline-box text-[#FAFAFA]">
                      v{release.version}
                    </span>
                    {pubDateFormatted && <span>{pubDateFormatted}</span>}
                  </div>
                </div>

                <h3 className="text-lg font-semibold text-[#FAFAFA]">
                  Cafofo Desktop para Windows
                </h3>

                <p className="text-sm text-[#A1A1AA] leading-relaxed bg-[#09090B] hairline-box rounded-xl p-4 font-mono text-xs">
                  {release.notes || FALLBACK_RELEASE.notes}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/[0.06]">
                <span className="font-mono text-[11px] text-[#71717A]">
                  Cafofo_{release.version}_x64-setup.exe • {installerSize}
                </span>
                <a
                  href={downloadUrl}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA]"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Baixar v{release.version}</span>
                </a>
              </div>
            </div>

            {/* Nota transparente sobre SmartScreen */}
            <div
              id="instalacao"
              className="lg:col-span-5 rounded-2xl bg-[#101014] hairline-box p-6 space-y-4"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[#16161C] hairline-box flex items-center justify-center">
                  <ShieldCheck className="w-4 h-4 text-[#EF4444]" />
                </div>
                <h3 className="text-sm font-semibold text-[#FAFAFA]">
                  Primeira instalação no Windows
                </h3>
              </div>

              <p className="text-xs text-[#A1A1AA] leading-relaxed">
                Como o Cafofo é um projeto independente e ainda não usa certificado
                EV pago da Microsoft, o Windows Defender SmartScreen pode exibir um
                aviso azul na primeira execução.
              </p>

              <ol className="space-y-2 text-xs text-[#A1A1AA] font-mono">
                <li className="flex gap-2">
                  <span className="text-[#EF4444]">01.</span>
                  <span>Execute o instalador Cafofo_{release.version}_x64-setup.exe</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-[#EF4444]">02.</span>
                  <span>Clique em &quot;Mais informações&quot; e depois em &quot;Executar assim mesmo&quot;</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-[#EF4444]">03.</span>
                  <span>As próximas atualizações acontecem direto dentro do app</span>
                </li>
              </ol>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/[0.06] py-8">
        <div className="max-w-6xl mx-auto px-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#71717A]">
          <div className="flex items-center gap-2.5">
            <BrandMark size="sm" />
            <span className="text-[#A1A1AA] font-medium">Cafofo</span>
            <span className="font-mono text-[11px]">• Obsidiana & Carmesim</span>
          </div>
          <div className="flex items-center gap-5 font-mono text-[11px]">
            <a
              href={WEB_APP_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-[#FAFAFA] transition-colors"
            >
              App Web
            </a>
            <a
              href={downloadUrl}
              className="hover:text-[#FAFAFA] transition-colors"
            >
              Download Windows
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
