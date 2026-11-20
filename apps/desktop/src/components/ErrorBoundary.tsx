import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Cafofo UI error boundary caught:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[100dvh] w-full overflow-x-hidden flex items-center justify-center bg-[#09090B] text-[#FAFAFA] p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
          <div className="max-w-lg w-full rounded-2xl bg-[#101014] hairline-box p-6 space-y-4 text-xs">
            <h1 className="text-sm font-semibold text-[#F87171]">
              Erro de renderização no Cafofo
            </h1>
            <pre className="whitespace-pre-wrap font-mono text-[#FAFAFA] bg-[#09090B] p-3 rounded-xl hairline-box">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FAFAFA] font-medium rounded-xl transition-colors"
            >
              Recarregar aplicativo
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
