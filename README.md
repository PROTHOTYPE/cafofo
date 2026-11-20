# Cafofo

Cliente de voz, texto e transmissão de tela pensado para uso diário com amigos — rápido, leve e com identidade própria.

Roda tanto como app desktop nativo no Windows (Tauri v2 + Rust) quanto na web.

## Estrutura do projeto

```text
apps/
  desktop/     Interface React + Vite e camada nativa Tauri v2 (Windows)
  landing/     Página de download conectada ao Cloudflare R2
  server/      Servidor Axum de sinalização WebSocket, LiveKit e bot de música
crates/
  audio-engine/     Captura de áudio e supressão de ruído (RNNoise)
  game-detector/    Detecção de jogos em execução no Windows
  protocol/         Tipos compartilhados entre Rust e TypeScript
  screen-capture/   Listagem de janelas e captura de tela nativa
packages/
  core-logic/  Stores Zustand, cliente Supabase e regras de negócio compartilhadas
supabase/
  migrations/  Schema do banco, RLS e políticas de storage
scripts/       Utilitários de desenvolvimento local, deploy e release
```

## Requisitos locais

- Node.js + Corepack (`pnpm@9.15.0`)
- Rust (`cargo` / `rustc`)
- Conta no Supabase e LiveKit Cloud (veja `.env.example` e `.env.production.example`)

## Rodando em desenvolvimento

Copie o arquivo de ambiente e preencha suas chaves:

```powershell
cp .env.example .env
```

Suba o ambiente completo (servidor + frontend):

```powershell
corepack pnpm install
corepack pnpm dev:all
```

Para abrir diretamente no app desktop:

```powershell
corepack pnpm dev:desktop
```

## Build e release do instalador Windows

Gera o instalador NSIS assinado (`.exe` + `.sig`) usando a chave local em `%USERPROFILE%\.tauri\cafofo.key`:

```powershell
corepack pnpm build:exe
```

Para incrementar versão, compilar, gerar o `latest.json` e publicar um release:

```powershell
corepack pnpm release
```

## Checagens

```powershell
corepack pnpm typecheck
cargo check --workspace
cargo test -p cafofo-server
```
