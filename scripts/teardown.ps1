#!/usr/bin/env pwsh
# ────────────────────────────────────────────────────────────────
# lectoria — Azure teardown script
#
# Deletes the resource group provisioned by ./scripts/provision.ps1.
# Also purges soft-deleted Cognitive Services accounts so the meter
# stops and the names are immediately reusable.
#
# Requires:
#   - az cli installed and signed in (`az login`)
#   - Permission to delete resources in the target subscription
#
# Usage:
#   ./scripts/teardown.ps1 -SubscriptionId <your-sub-id>
#   ./scripts/teardown.ps1 -SubscriptionId <id> -ResourceGroup lectoria-rg -Force
# ────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$SubscriptionId,

  [string]$ResourceGroup = 'lectoria-rg',

  # Skip the interactive confirmation prompt.
  [switch]$Force,

  # Also delete (purge) soft-deleted Cognitive Services accounts. Default: on.
  # Pass -PurgeSoftDeleted:$false to leave them in the 48h recovery window.
  [bool]$PurgeSoftDeleted = $true
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "─── $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host $msg -ForegroundColor Yellow }

# ── Select subscription ────────────────────────────────────────
if ($SubscriptionId) { az account set --subscription $SubscriptionId | Out-Null }
$sub = az account show --query id -o tsv
$subName = az account show --query name -o tsv
Step "Using subscription: $subName ($sub)"

# ── Verify the resource group exists ───────────────────────────
$exists = az group exists -n $ResourceGroup
if ($exists -ne 'true') {
  Warn "Resource group '$ResourceGroup' does not exist. Nothing to do."
  exit 0
}

# ── Capture Cognitive Services accounts before deletion ────────
# (Their names are needed for the purge step, but `az resource list` won't
# see them once the group is gone.)
Step "Inspecting Cognitive Services accounts in '$ResourceGroup'"
$cogAccountsJson = az cognitiveservices account list -g $ResourceGroup -o json
$cogAccounts = $cogAccountsJson | ConvertFrom-Json
if ($cogAccounts.Count -gt 0) {
  foreach ($acct in $cogAccounts) {
    Write-Host "    • $($acct.name) ($($acct.kind), $($acct.location))"
  }
} else {
  Write-Host '    (none)'
}

# ── Confirm ────────────────────────────────────────────────────
if (-not $Force) {
  Write-Host ''
  Warn "This will DELETE the resource group '$ResourceGroup' and ALL resources inside it."
  if ($PurgeSoftDeleted -and $cogAccounts.Count -gt 0) {
    Warn 'It will then PURGE the soft-deleted Cognitive Services accounts (no 48h recovery).'
  }
  $answer = Read-Host "Type the resource group name to confirm"
  if ($answer -ne $ResourceGroup) {
    Warn 'Confirmation did not match. Aborting.'
    exit 1
  }
}

# ── Delete resource group ──────────────────────────────────────
Step "Deleting resource group '$ResourceGroup' (this may take a few minutes)"
az group delete -n $ResourceGroup --yes | Out-Null

# ── Purge soft-deleted Cognitive Services accounts ─────────────
if ($PurgeSoftDeleted -and $cogAccounts.Count -gt 0) {
  Step 'Purging soft-deleted Cognitive Services accounts'
  foreach ($acct in $cogAccounts) {
    Write-Host "    • purging $($acct.name) in $($acct.location)..."
    # `az cognitiveservices account purge` is idempotent; tolerate "not found"
    # for accounts that were never soft-deleted (rare, but possible).
    try {
      az cognitiveservices account purge `
        --location $acct.location `
        --resource-group $ResourceGroup `
        --name $acct.name 2>$null | Out-Null
    } catch {
      Warn "      (purge failed for $($acct.name); may already be fully deleted)"
    }
  }
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ' Done. The meter has stopped for these resources.'             -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''
Write-Host "Don't forget to clear the provisioned values from your .env if you saved them."
