/**
 * Host implementations of `@paperclipai/plugin-sdk/ui/components`.
 *
 * The SDK package declares each component as a factory stub that delegates
 * to `globalThis.__paperclipPluginBridge__.sdkUi[name]` at render time. This
 * file provides the runtime implementations the host registers on that bridge
 * map (see `bridge-init.ts`).
 *
 * Visual contract: components must match the host's design tokens so plugin
 * UIs are visually consistent with the rest of the host shell.
 *
 * Scope (PLA-117): only `Spinner`, `StatusBadge`, and `ErrorBoundary` ship
 * in v1. The other 8 SDK kit stubs remain factory-only and throw at runtime
 * via `renderSdkUiComponent` until their host implementations are added — a
 * future addition is a one-line entry on the bridge `sdkUi` map.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps {
  size?: SpinnerSize;
  label?: string;
}

const SPINNER_SIZE_CLASS: Record<SpinnerSize, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-6 w-6",
};

/**
 * Loading indicator. Mirrors the `Loader2 + animate-spin` pattern used
 * throughout the host (e.g. `WorkspaceRuntimeControls`, `OnboardingWizard`).
 */
export function Spinner({ size = "md", label = "Loading" }: SpinnerProps) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn("animate-spin text-muted-foreground", SPINNER_SIZE_CLASS[size])}
    />
  );
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

/**
 * SDK variant set — kept in sync with `StatusBadgeVariant` declared in
 * `packages/plugins/sdk/src/ui/components.ts`. The SDK is the source of truth
 * for the public contract; if it grows we extend this map.
 */
export type StatusBadgeVariant = "ok" | "warning" | "error" | "info" | "pending";

export interface StatusBadgeProps {
  label: string;
  status: StatusBadgeVariant;
}

/**
 * Variant → host color tokens. Tokens picked from `lib/status-colors.ts` so
 * a plugin badge sits visually beside host badges using the same hues.
 */
const STATUS_BADGE_VARIANT_CLASS: Record<StatusBadgeVariant, string> = {
  ok: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  info: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
};

/**
 * Pill badge matching the host's `StatusBadge` geometry
 * (`ui/src/components/StatusBadge.tsx`).
 */
export function StatusBadge({ label, status }: StatusBadgeProps) {
  return (
    <span
      data-slot="plugin-status-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        STATUS_BADGE_VARIANT_CLASS[status],
      )}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Class component error boundary for use inside plugin UIs. Visual contract
 * matches the host's existing plugin-failure surface in `slots.tsx`
 * (`border-destructive/30 bg-destructive/5 text-destructive`).
 *
 * The host already wraps every plugin slot mount in `PluginSlotErrorBoundary`
 * so plugin-level rendering errors cannot crash the host. This component lets
 * plugin authors place finer-grained boundaries inside their own subtree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError) {
      try {
        this.props.onError(error, info);
      } catch (handlerErr) {
        console.error("Plugin ErrorBoundary onError handler threw", handlerErr);
      }
    }
    console.error("Plugin ErrorBoundary caught error", { error, componentStack: info.componentStack });
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      >
        Something went wrong rendering this component.
      </div>
    );
  }
}
