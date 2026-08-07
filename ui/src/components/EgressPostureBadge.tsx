import { Ban, Eye, ShieldCheck } from "lucide-react";
import type { ComponentType } from "react";
import type { EgressPosture } from "../api/secrets";
import { cn } from "../lib/utils";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

/**
 * Triple-redundant posture coding (icon + label word + colour). No two postures
 * share any of the three channels, and `deny_all` deliberately never reuses the
 * word "Enforcing" so it cannot be mentally merged with the healthy state.
 */
const POSTURE_STYLES: Record<EgressPosture, string> = {
  // Amber, not neutral — "nothing is being blocked yet" still deserves attention.
  log_only:
    "border-amber-400/70 bg-amber-100 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200",
  enforcing:
    "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  // Louder than the muted outline style used elsewhere — this is the posture
  // the parent chain exists to surface, not just one more chip.
  deny_all:
    "border-red-400 bg-red-100 text-red-900 dark:border-red-500/50 dark:bg-red-500/20 dark:text-red-200",
};

const POSTURE_ICONS: Record<EgressPosture, IconComponent> = {
  log_only: Eye,
  enforcing: ShieldCheck,
  deny_all: Ban,
};

// Distinct label words — `deny_all` never says "Enforcing".
const POSTURE_LABELS: Record<EgressPosture, string> = {
  log_only: "Not enforced",
  enforcing: "Enforcing",
  deny_all: "Blocking all egress",
};

interface EgressPostureBadgeProps {
  posture: EgressPosture;
  className?: string;
}

export function EgressPostureBadge({ posture, className }: EgressPostureBadgeProps) {
  const Icon = POSTURE_ICONS[posture];
  const label = POSTURE_LABELS[posture];
  return (
    <span
      data-testid={`egress-posture-badge-${posture}`}
      data-posture={posture}
      aria-label={`Egress posture: ${label}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-tight",
        POSTURE_STYLES[posture],
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export const EGRESS_POSTURE_LABELS = POSTURE_LABELS;
