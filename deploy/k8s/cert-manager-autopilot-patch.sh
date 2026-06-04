#!/usr/bin/env bash
# GKE Autopilot fix for cert-manager installed from the upstream static manifest.
#
# Autopilot forbids writes to the managed `kube-system` namespace, where the
# static manifest puts cert-manager's leader-election leases. Without this the
# cainjector can't acquire its lease → never injects the webhook CA bundle →
# every ClusterIssuer/Certificate apply fails with:
#   x509: certificate signed by unknown authority
#
# This repoints leader-election to the `cert-manager` namespace. Pair it with
# cert-manager-autopilot-rbac.yaml, which grants the matching lease RBAC there.
# (Helm's `global.leaderElection.namespace=cert-manager` does both at once.)
#
# Run AFTER `kubectl apply -f cert-manager.yaml`. Requires: kubectl, jq.
# Version-agnostic: it rewrites only the leader-election-namespace arg, leaving
# every other flag (incl. the version-pinned acmesolver image) untouched.
set -euo pipefail

NS=cert-manager

patch_leader_ns() {
  local dep="$1"
  local args
  # Rewrite kube-system → cert-manager in whichever arg carries it. If no arg
  # references kube-system (some versions omit the flag), append it explicitly.
  args=$(kubectl -n "$NS" get deploy "$dep" -o json | jq -c \
    --arg ns "$NS" '
      (.spec.template.spec.containers[0].args // [])
      | map(gsub("kube-system"; $ns)) as $a
      | if ($a | any(startswith("--leader-election-namespace=")))
        then $a else $a + ["--leader-election-namespace=" + $ns] end
    ')
  echo "  $dep args → $args"
  kubectl -n "$NS" patch deploy "$dep" --type=json \
    -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/args\",\"value\":$args}]"
}

echo "Repointing leader-election namespace → ${NS}"
patch_leader_ns cert-manager
patch_leader_ns cert-manager-cainjector

echo "Applying leader-election RBAC in ${NS}"
kubectl apply -f "$(dirname "$0")/cert-manager-autopilot-rbac.yaml"

echo "Restarting so leases re-attempt immediately"
kubectl -n "$NS" rollout restart deploy/cert-manager deploy/cert-manager-cainjector
kubectl -n "$NS" rollout status deploy/cert-manager-cainjector --timeout=120s

echo "Done. Verify the webhook CA bundle is injected (should be a long number):"
kubectl get validatingwebhookconfiguration cert-manager-webhook \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | wc -c
