import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  ArrowLeft,
  Loader2,
  Lock,
  Plus,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import {
  secretsApi,
  type EgressBinding,
  type EgressPosture,
} from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const POSTURE_META: Record<
  EgressPosture,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; hint: string }
> = {
  log_only: {
    label: "Log only",
    variant: "secondary",
    hint: "Denied origins are recorded but still allowed. Not yet enforcing.",
  },
  enforcing: {
    label: "Enforcing",
    variant: "default",
    hint: "Only allowlisted origins can be reached with this secret.",
  },
  deny_all: {
    label: "Deny all",
    variant: "destructive",
    hint: "Enforcing with an empty allowlist — all egress for this secret is blocked.",
  },
};

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function bindingTitle(binding: EgressBinding): string {
  if (binding.label) return binding.label;
  return `${binding.targetType}:${binding.targetId}`;
}

/**
 * One binding's review + edit card. Local state holds the OPERATOR'S working
 * allowlist, initialised from the persisted list. Harvested suggestions render
 * UNCHECKED unless the origin is already on the allowlist — nothing is
 * auto-selected (allowlist-poisoning guard). Per-binding enforce only; there is
 * deliberately no bulk enforce-all control.
 */
function BindingCard({
  binding,
  companyId,
}: {
  binding: EgressBinding;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<string[]>(binding.allowedEgress);
  const [manual, setManual] = useState("");
  const [confirmEnforce, setConfirmEnforce] = useState(false);

  // Re-sync the working copy when the server data changes (e.g. after a save
  // invalidates and refetches), so the card reflects persisted truth.
  useEffect(() => {
    setDraft(binding.allowedEgress);
  }, [binding.allowedEgress]);

  const dirty = !arraysEqual(draft, binding.allowedEgress);
  const posture = POSTURE_META[binding.posture];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.egressBindings(companyId) });

  const saveMutation = useMutation({
    mutationFn: () => secretsApi.setEgressAllowlist(companyId, binding.id, draft),
    onSuccess: (res) => {
      pushToast({
        tone: "success",
        title: "Allowlist saved",
        body:
          res.handlesPurged > 0
            ? `${res.handlesPurged} in-flight handle(s) purged so the change applies now.`
            : "The binding's allowlist was updated.",
      });
      invalidate();
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Could not save allowlist",
        body: err instanceof ApiError ? err.message : String(err),
      });
    },
  });

  const enforceMutation = useMutation({
    mutationFn: (allowEmpty: boolean) =>
      secretsApi.setEgressEnforcement(companyId, binding.id, {
        enforced: true,
        allowEmpty,
      }),
    onSuccess: () => {
      pushToast({
        tone: "success",
        title: "Enforcement on",
        body: `${bindingTitle(binding)} now enforces its egress allowlist.`,
      });
      setConfirmEnforce(false);
      invalidate();
    },
    onError: (err) => {
      setConfirmEnforce(false);
      pushToast({
        tone: "error",
        title: "Could not enforce",
        body: err instanceof ApiError ? err.message : String(err),
      });
    },
  });

  const toggleOrigin = (origin: string, checked: boolean) => {
    setDraft((prev) =>
      checked ? (prev.includes(origin) ? prev : [...prev, origin]) : prev.filter((o) => o !== origin),
    );
  };

  const addManual = () => {
    const entry = manual.trim();
    if (!entry) return;
    setDraft((prev) => (prev.includes(entry) ? prev : [...prev, entry]));
    setManual("");
  };

  const persistedEmpty = binding.allowedEgress.length === 0;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{bindingTitle(binding)}</CardTitle>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {binding.configPath}
            </p>
          </div>
          <Badge variant={posture.variant} title={posture.hint}>
            {binding.posture === "enforcing" || binding.posture === "deny_all" ? (
              <ShieldCheck />
            ) : (
              <ShieldAlert />
            )}
            {posture.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{posture.hint}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Current / working allowlist */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Allowlist</span>
          {draft.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Empty — enforcing now would deny all egress for this secret.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {draft.map((origin) => (
                <span
                  key={origin}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs"
                >
                  <span className="truncate font-mono">{origin}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${origin}`}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => toggleOrigin(origin, false)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Add a custom origin */}
        <div className="flex gap-2">
          <Input
            value={manual}
            placeholder="Add an origin, e.g. https://api.example.com"
            className="h-8 text-xs"
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addManual();
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={addManual} disabled={!manual.trim()}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {/* Harvested suggestions — never pre-checked */}
        {binding.suggestions.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Suggested from denied traffic
            </span>
            <p className="text-[11px] text-muted-foreground">
              Origins this secret tried to reach. Check the ones you trust to add them to the
              allowlist, then save. Nothing here is applied until you do.
            </p>
            <div className="space-y-0.5">
              {binding.suggestions.map((s) => (
                <label
                  key={s.origin}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-accent/50"
                >
                  <Checkbox
                    checked={draft.includes(s.origin)}
                    onCheckedChange={(v) => toggleOrigin(s.origin, v === true)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.origin}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {s.count}× · last {new Date(s.lastSeen).toLocaleDateString()}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save allowlist
          </Button>

          {binding.egressAllowlistEnforced ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
              Already enforcing
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setConfirmEnforce(true)}
              disabled={enforceMutation.isPending || dirty}
              title={dirty ? "Save the allowlist first" : undefined}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Enforce
            </Button>
          )}
          {dirty && !binding.egressAllowlistEnforced ? (
            <span className="text-[11px] text-muted-foreground">Save before enforcing.</span>
          ) : null}
        </div>
      </CardContent>

      <AlertDialog open={confirmEnforce} onOpenChange={setConfirmEnforce}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enforce egress on {bindingTitle(binding)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {persistedEmpty ? (
                <>
                  This allowlist is <strong>empty</strong>, so enforcing will block{" "}
                  <strong>all</strong> outbound requests made with this secret. Only continue if a
                  full deny is intended. This affects this one binding, not any other.
                </>
              ) : (
                <>
                  Requests made with this secret to any origin outside its {binding.allowedEgress.length}
                  -entry allowlist will be blocked. This affects this one binding only — siblings stay
                  log-only.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => enforceMutation.mutate(persistedEmpty)}>
              {persistedEmpty ? "Enforce deny-all" : "Enforce"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export function EgressBindings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Secrets", href: "/company/settings/secrets" }, { label: "Egress" }]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.egressBindings(selectedCompanyId)
      : ["secret-egress-bindings", "__disabled__"],
    queryFn: () => secretsApi.listEgressBindings(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const bindings = useMemo(() => query.data?.bindings ?? [], [query.data]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <Link
          to="/company/settings/secrets"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Secrets
        </Link>
        <h1 className="text-lg font-semibold">Secret egress bindings</h1>
        <p className="text-sm text-muted-foreground">
          Review which outbound origins each secret may reach, seed an allowlist from denied
          traffic, and turn on enforcement one binding at a time.
        </p>
      </div>

      {query.isError ? (
        <EmptyState
          icon={ShieldAlert}
          message={
            query.error instanceof ApiError
              ? query.error.status === 403
                ? "This surface is operator-only — sign in from a browser session (a board API key cannot reach it)."
                : query.error.message
              : "Unexpected error loading bindings."
          }
        />
      ) : query.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : bindings.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          message="No secret in this company currently binds an egress allowlist."
        />
      ) : (
        <div className="space-y-3">
          {bindings.map((binding) => (
            <BindingCard key={binding.id} binding={binding} companyId={selectedCompanyId!} />
          ))}
        </div>
      )}
    </div>
  );
}

export default EgressBindings;
