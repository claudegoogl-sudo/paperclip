import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, ShieldCheck, ShieldOff } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EgressPostureBadge } from "@/components/EgressPostureBadge";
import { useToastActions } from "@/context/ToastContext";
import {
  secretsApi,
  type EgressBinding,
  type EgressPosture,
} from "../../api/secrets";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { mergeOriginIntoAllowlist } from "./egress-allowlist";

/**
 * Egress posture panel for a single secret.
 *
 * Bindings come from the company-wide `listEgressBindings` endpoint, filtered
 * client-side on `secretId`. Posture is read straight from the response's
 * `posture` field — never re-derived from `egressAllowlistEnforced` +
 * `allowedEgress.length`. Re-inferring posture client-side is exactly what
 * left born-enforcing bindings invisible, and is what the server's posture
 * helper exists to prevent.
 */
export function EgressTab({
  companyId,
  secretId,
}: {
  companyId: string;
  secretId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [confirm, setConfirm] = useState<ConfirmState>({ type: "none" });

  const bindingsQuery = useQuery({
    queryKey: queryKeys.secrets.egressBindings(companyId),
    queryFn: () => secretsApi.listEgressBindings(companyId),
    enabled: Boolean(companyId),
  });

  const secretBindings = (bindingsQuery.data?.bindings ?? []).filter(
    (binding) => binding.secretId === secretId,
  );

  function invalidateBindings() {
    queryClient.invalidateQueries({
      queryKey: queryKeys.secrets.egressBindings(companyId),
    });
  }

  const allowMutation = useMutation({
    mutationFn: ({
      binding,
      origin,
    }: {
      binding: EgressBinding;
      origin: string;
    }) => {
      // Send the full merged list. The endpoint is replace-semantics.
      const next = mergeOriginIntoAllowlist(binding.allowedEgress, origin);
      return secretsApi.setEgressAllowlist(companyId, binding.id, next);
    },
    onSuccess: (data, { binding }) => {
      // Surface handlesPurged so re-minted consumers are not a surprise.
      const body =
        data.handlesPurged > 0
          ? `Added to "${bindingLabel(binding)}". ${data.handlesPurged} in-flight handle(s) re-minted under the new allowlist.`
          : `Added to "${bindingLabel(binding)}".`;
      pushToast({ title: "Origin allowed", body, tone: "success" });
      invalidateBindings();
    },
    onError: (err) => {
      pushToast({
        title: "Couldn't allow origin",
        body: err instanceof ApiError ? err.message : "Unexpected error",
        tone: "error",
      });
    },
  });

  const enforceMutation = useMutation({
    mutationFn: (input: {
      binding: EgressBinding;
      enforced: boolean;
      allowEmpty?: boolean;
    }) =>
      secretsApi.setEgressEnforcement(companyId, input.binding.id, {
        enforced: input.enforced,
        allowEmpty: input.allowEmpty,
      }),
    onSuccess: (data, { binding, enforced }) => {
      const verb = enforced ? "Egress enforcing" : "Egress no longer enforced";
      const body =
        data.handlesPurged > 0
          ? `"${bindingLabel(binding)}". ${data.handlesPurged} in-flight handle(s) re-minted under the new posture.`
          : `"${bindingLabel(binding)}".`;
      pushToast({ title: verb, body, tone: enforced ? "success" : "info" });
      invalidateBindings();
    },
    onError: (err) => {
      pushToast({
        title: "Couldn't change enforcement",
        body: err instanceof ApiError ? err.message : "Unexpected error",
        tone: "error",
      });
    },
  });

  if (bindingsQuery.isPending) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (bindingsQuery.isError) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        Couldn’t load egress bindings. Try refreshing the secret.
      </div>
    );
  }
  if (secretBindings.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        No borrowed-handle bindings for this secret. Egress posture only applies
        to bindings that mint handles to consumers.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {secretBindings.map((binding) => (
        <EgressBindingCard
          key={binding.id}
          binding={binding}
          pendingOriginFor={null}
          onAllowOrigin={(origin) =>
            allowMutation.mutate({ binding, origin })
          }
          allowPending={allowMutation.isPending}
          onOpenConfirm={(next) => setConfirm({ type: next, bindingId: binding.id })}
          enforcePending={enforceMutation.isPending}
        />
      ))}

      <EgressConfirmDialog
        state={confirm}
        bindings={secretBindings}
        pending={enforceMutation.isPending}
        onClose={() => setConfirm({ type: "none" })}
        onConfirm={(opts) => {
          if (confirm.type === "none") return;
          const target = secretBindings.find((b) => b.id === confirm.bindingId);
          if (!target) return;
          enforceMutation.mutate(
            { binding: target, enforced: opts.enforced, allowEmpty: opts.allowEmpty },
            { onSuccess: () => setConfirm({ type: "none" }) },
          );
        }}
      />
    </div>
  );
}

type ConfirmState =
  | { type: "none" }
  | { type: "enforce"; bindingId: string }
  | { type: "deny_all"; bindingId: string }
  | { type: "unenforce"; bindingId: string };

function EgressBindingCard({
  binding,
  onAllowOrigin,
  allowPending,
  onOpenConfirm,
  enforcePending,
  pendingOriginFor,
}: {
  binding: EgressBinding;
  onAllowOrigin: (origin: string) => void;
  allowPending: boolean;
  onOpenConfirm: (next: ConfirmState["type"]) => void;
  enforcePending: boolean;
  pendingOriginFor: string | null;
}) {
  const posture = binding.posture;
  const allowlistCount = binding.allowedEgress.length;
  const targetType = binding.targetType;
  const targetId = binding.targetId;
  const configPath = binding.configPath;
  const label = bindingLabel(binding);

  return (
    <div
      data-testid={`egress-binding-card-${binding.id}`}
      data-posture={posture}
      className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-xs"
    >
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium capitalize">{targetType}</span>
          <EgressPostureBadge posture={posture} />
        </div>
        <div className="truncate font-medium">{label}</div>
        <div className="font-mono text-[11px] text-muted-foreground break-all">
          {targetId}
        </div>
        <div className="text-[11px] text-muted-foreground break-all">
          {configPath}
        </div>
      </div>

      <PostureCaption posture={posture} allowlistCount={allowlistCount} />

      <AllowlistBlock binding={binding} />

      <SuggestionsBlock
        binding={binding}
        onAllowOrigin={onAllowOrigin}
        allowPending={allowPending}
        pendingOriginFor={pendingOriginFor}
      />

      <EnforcementControls
        binding={binding}
        onOpenConfirm={onOpenConfirm}
        enforcePending={enforcePending}
      />
    </div>
  );
}

function PostureCaption({
  posture,
  allowlistCount,
}: {
  posture: EgressPosture;
  allowlistCount: number;
}) {
  switch (posture) {
    case "log_only":
      return (
        <p
          data-testid="egress-posture-caption"
          data-posture="log_only"
          className="text-[11px] leading-snug text-amber-800 dark:text-amber-300"
        >
          Egress is logged but never blocked. Origins added below won’t restrict
          anything until enforcement is turned on.
        </p>
      );
    case "enforcing":
      return (
        <p
          data-testid="egress-posture-caption"
          data-posture="enforcing"
          className="text-[11px] leading-snug text-emerald-800 dark:text-emerald-300"
        >
          Only {allowlistCount} allowed origin{allowlistCount === 1 ? "" : "s"} can
          reach this secret’s egress. Every other destination is blocked.
        </p>
      );
    case "deny_all":
      return (
        <p
          data-testid="egress-posture-caption"
          data-posture="deny_all"
          className="text-[11px] leading-snug text-red-800 dark:text-red-300"
        >
          No origins are allowlisted — every request is denied. This is almost
          always a misconfiguration.
        </p>
      );
  }
}

function AllowlistBlock({ binding }: { binding: EgressBinding }) {
  const items = binding.allowedEgress;
  return (
    <section className="space-y-1">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Allowed origins ({items.length})
      </h4>
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">
          No allowed origins yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((origin) => (
            <li
              key={origin}
              className="rounded border border-border bg-background px-2 py-1 font-mono text-[11px] break-all"
            >
              {origin}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionsBlock({
  binding,
  onAllowOrigin,
  allowPending,
  pendingOriginFor,
}: {
  binding: EgressBinding;
  onAllowOrigin: (origin: string) => void;
  allowPending: boolean;
  pendingOriginFor: string | null;
}) {
  const suggestions = binding.suggestions;
  if (suggestions.length === 0) return null;
  return (
    <section className="space-y-1">
      <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Suggested origins (not applied)</span>
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
          {suggestions.length}
        </Badge>
      </h4>
      <ul className="space-y-1.5">
        {suggestions.map((s) => {
          const alreadyAllowed = binding.allowedEgress.includes(s.origin);
          const isPending =
            allowPending && pendingOriginFor === s.origin;
          return (
            <li
              key={s.origin}
              className="space-y-1 rounded border border-border bg-background p-2"
            >
              <div className="flex items-start gap-2">
                <Checkbox
                  checked={false}
                  disabled
                  aria-label={`Suggestion ${s.origin} is never auto-applied`}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="font-mono text-[11px] break-all">{s.origin}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {s.count} request{s.count === 1 ? "" : "s"} · last seen{" "}
                    {formatRelative(s.lastSeen)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isPending || alreadyAllowed}
                  onClick={() => onAllowOrigin(s.origin)}
                  className="shrink-0"
                >
                  {alreadyAllowed ? "Allowed" : "Allow"}
                </Button>
              </div>
              {binding.posture === "log_only" ? (
                <p className="text-[11px] text-amber-800 dark:text-amber-300">
                  Won’t restrict anything until enforcement is turned on below.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EnforcementControls({
  binding,
  onOpenConfirm,
  enforcePending,
}: {
  binding: EgressBinding;
  onOpenConfirm: (next: ConfirmState["type"]) => void;
  enforcePending: boolean;
}) {
  const posture = binding.posture;
  return (
    <section className="space-y-1">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Enforcement
      </h4>
      <div className="flex flex-wrap gap-1.5">
        {posture === "log_only" ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={
                enforcePending ||
                binding.allowedEgress.length === 0
              }
              onClick={() => onOpenConfirm("enforce")}
            >
              <ShieldCheck className="mr-1 h-3.5 w-3.5" />
              Enforce allowlist
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={enforcePending}
              onClick={() => onOpenConfirm("deny_all")}
            >
              <Ban className="mr-1 h-3.5 w-3.5" />
              Block all egress
            </Button>
          </>
        ) : posture === "enforcing" ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={enforcePending}
              onClick={() => onOpenConfirm("unenforce")}
            >
              <ShieldOff className="mr-1 h-3.5 w-3.5" />
              Stop enforcing
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={enforcePending}
              onClick={() => onOpenConfirm("deny_all")}
            >
              <Ban className="mr-1 h-3.5 w-3.5" />
              Block all egress
            </Button>
          </>
        ) : (
          // deny_all
          <Button
            type="button"
            size="sm"
            disabled={enforcePending || binding.allowedEgress.length === 0}
            onClick={() => onOpenConfirm("enforce")}
          >
            <ShieldCheck className="mr-1 h-3.5 w-3.5" />
            Enforce allowlist
          </Button>
        )}
      </div>
    </section>
  );
}

function EgressConfirmDialog({
  state,
  bindings,
  pending,
  onClose,
  onConfirm,
}: {
  state: ConfirmState;
  bindings: EgressBinding[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (opts: { enforced: boolean; allowEmpty?: boolean }) => void;
}) {
  const [understood, setUnderstood] = useState(false);
  if (state.type === "none") return null;
  const binding = bindings.find((b) => b.id === state.bindingId);
  if (!binding) return null;

  const resetAndClose = () => {
    setUnderstood(false);
    onClose();
  };

  let title: string;
  let description: React.ReactNode;
  let actionLabel: string;
  let actionVariant: "default" | "destructive";
  let actionDisabled = pending;
  let onAction: () => void;

  if (state.type === "enforce") {
    title = "Enforce egress allowlist?";
    description = (
      <>
        Only <strong>{binding.allowedEgress.length}</strong> allowed
        origin{binding.allowedEgress.length === 1 ? "" : "s"} will be able to
        reach <span className="font-medium">{bindingLabel(binding)}</span>’s
        egress. Every other destination will be blocked immediately. In-flight
        handles will be re-minted under the new posture.
      </>
    );
    actionLabel = "Enforce";
    actionVariant = "default";
    onAction = () => onConfirm({ enforced: true });
  } else if (state.type === "deny_all") {
    title = "Block ALL egress for this binding?";
    description = (
      <div className="space-y-3">
        <p>
          This blocks ALL egress for{" "}
          <span className="font-medium">{bindingLabel(binding)}</span> — nothing
          will get through. This is almost always a mistake unless you intend to
          fully cut off this secret’s outbound access.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={understood}
            onCheckedChange={(v) => setUnderstood(Boolean(v))}
            className="mt-0.5"
          />
          <span>
            I understand this blocks all traffic for this binding, including any
            currently in-flight consumers.
          </span>
        </label>
      </div>
    );
    actionLabel = "Block all egress";
    actionVariant = "destructive";
    actionDisabled = pending || !understood;
    onAction = () => onConfirm({ enforced: true, allowEmpty: true });
  } else {
    // unenforce
    title = "Turn enforcement off?";
    description = (
      <>
        Egress will no longer be restricted for{" "}
        <span className="font-medium">{bindingLabel(binding)}</span> — every
        origin will be allowed and only logged. This removes a safeguard, not a
        neutral toggle.
      </>
    );
    actionLabel = "Stop enforcing";
    actionVariant = "default";
    onAction = () => onConfirm({ enforced: false });
  }

  return (
    <AlertDialog
      open
      onOpenChange={(o) => {
        if (!o) resetAndClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={resetAndClose}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={actionDisabled}
            onClick={(e) => {
              e.preventDefault();
              if (actionDisabled) return;
              onAction();
            }}
            className={cn(
              actionVariant === "destructive" &&
                "bg-destructive text-white hover:bg-destructive/90",
            )}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function bindingLabel(binding: EgressBinding): string {
  return binding.label?.trim() || binding.configPath || binding.targetId;
}

function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
