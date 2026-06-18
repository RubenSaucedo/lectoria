#!/usr/bin/env pwsh
# ────────────────────────────────────────────────────────────────
# lectoria — Azure provisioning script
#
# Stands up the resources needed to run lectoria end-to-end:
#   - Resource group
#   - Azure AI Speech (S0) resource
#   - Azure OpenAI (S0) resource with custom domain (required for Entra auth)
#   - gpt-4o model deployment
#   - RBAC role assignments to the current user
#
# Requires:
#   - az cli installed and signed in (`az login`)
#   - Owner or (Contributor + User Access Administrator) on the target subscription
#
# Usage:
#   ./scripts/provision.ps1 -SubscriptionId <your-sub-id>
#   ./scripts/provision.ps1 -SubscriptionId <id> -Location eastus2
# ────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$SubscriptionId,

  [string]$ResourceGroup = 'lectoria-rg',
  [string]$Location = 'eastus',
  [string]$SpeechName = "lectoria-speech-$(Get-Random -Maximum 9999)",
  [string]$OpenAIName = "lectoria-openai-$(Get-Random -Maximum 9999)",
  [string]$OpenAIDeployment = 'gpt-4o',
  [string]$OpenAIModelName = 'gpt-4o',
  [string]$OpenAIModelVersion = '2024-11-20',
  [int]$OpenAICapacity = 10
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "─── $msg" -ForegroundColor Cyan }

# ── Select subscription ────────────────────────────────────────
if ($SubscriptionId) { az account set --subscription $SubscriptionId | Out-Null }
$sub = az account show --query id -o tsv
$subName = az account show --query name -o tsv
Step "Using subscription: $subName ($sub)"

# ── Resource group ─────────────────────────────────────────────
Step "Creating resource group '$ResourceGroup' in $Location"
az group create -n $ResourceGroup -l $Location | Out-Null

# ── Azure AI Speech ────────────────────────────────────────────
Step "Creating Speech resource '$SpeechName'"
az cognitiveservices account create `
  -n $SpeechName -g $ResourceGroup -l $Location `
  --kind SpeechServices --sku S0 --yes | Out-Null

$speechId = az cognitiveservices account show -n $SpeechName -g $ResourceGroup --query id -o tsv

# ── Azure OpenAI ───────────────────────────────────────────────
# Custom domain name is required for Entra ID token auth on Azure OpenAI.
Step "Creating Azure OpenAI resource '$OpenAIName' (custom domain enabled)"
az cognitiveservices account create `
  -n $OpenAIName -g $ResourceGroup -l $Location `
  --kind OpenAI --sku S0 --custom-domain $OpenAIName --yes | Out-Null

$openaiId = az cognitiveservices account show -n $OpenAIName -g $ResourceGroup --query id -o tsv
$openaiEndpoint = az cognitiveservices account show -n $OpenAIName -g $ResourceGroup --query properties.endpoint -o tsv

# ── Deploy GPT-4o ──────────────────────────────────────────────
Step "Deploying model '$OpenAIDeployment' ($OpenAIModelName v$OpenAIModelVersion, $OpenAICapacity TPM units)"
az cognitiveservices account deployment create `
  -g $ResourceGroup -n $OpenAIName `
  --deployment-name $OpenAIDeployment `
  --model-name $OpenAIModelName `
  --model-version $OpenAIModelVersion `
  --model-format OpenAI `
  --sku-capacity $OpenAICapacity --sku-name Standard | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create deployment '$OpenAIDeployment' ($OpenAIModelName v$OpenAIModelVersion). If the model version is deprecated, list current versions with: az cognitiveservices model list -l $Location --query ""[?model.name=='$OpenAIModelName'].model.version"" -o tsv"
}
$createdDeployment = az cognitiveservices account deployment show -g $ResourceGroup -n $OpenAIName --deployment-name $OpenAIDeployment --query name -o tsv
if (-not $createdDeployment) {
  throw "Deployment '$OpenAIDeployment' not visible after create — check Azure Portal."
}

# ── RBAC ───────────────────────────────────────────────────────
$userId = az ad signed-in-user show --query id -o tsv
$userUpn = az ad signed-in-user show --query userPrincipalName -o tsv
Step "Assigning RBAC roles to $userUpn"

az role assignment create --assignee $userId --role 'Cognitive Services User'        --scope $speechId  | Out-Null
az role assignment create --assignee $userId --role 'Cognitive Services OpenAI User' --scope $openaiId  | Out-Null

# ── Output ─────────────────────────────────────────────────────
Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ' Done. Paste the following into your .env file:'              -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''
Write-Host "AZURE_SPEECH_REGION=$Location"
Write-Host "AZURE_SPEECH_RESOURCE_ID=$speechId"
Write-Host "AZURE_OPENAI_ENDPOINT=$openaiEndpoint"
Write-Host "AZURE_OPENAI_DEPLOYMENT=$OpenAIDeployment"
Write-Host 'AZURE_OPENAI_API_VERSION=2024-08-01-preview'
Write-Host ''
Write-Host 'Then verify with:  npx tsx src/cli.ts run samples\your.pdf --lang en,es'
