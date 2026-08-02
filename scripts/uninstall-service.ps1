param(
    [Parameter(Mandatory=$true)]
    [string]$NssmPath,
    
    [int]$Port,
    
    [string]$ServiceName = "PixelAgents"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script must be run as Administrator to remove firewall rules and uninstall services."
    exit 1
}

if (-not (Test-Path $NssmPath)) {
    Write-Error "NSSM not found at: $NssmPath"
    exit 1
}

Write-Host "Uninstalling service: $ServiceName" -ForegroundColor Cyan
Write-Host ""

$status = & $NssmPath status $ServiceName 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Service not found: $ServiceName"
} else {
    if ($status -match "SERVICE_RUNNING" -or $status -match "SERVICE_START_PENDING") {
        Write-Host "Stopping service..." -ForegroundColor Yellow
        & $NssmPath stop $ServiceName confirm
        Start-Sleep -Seconds 2
    }

    Write-Host "Removing service..." -ForegroundColor Yellow
    & $NssmPath remove $ServiceName confirm
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to remove service"
        exit 1
    }
    Write-Host "Service removed" -ForegroundColor Green
    Write-Host ""
}

if ($Port) {
    $firewallRuleName = "PixelAgents-Port$Port"
    Write-Host "Removing firewall rule: $firewallRuleName" -ForegroundColor Cyan
    Remove-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
    Write-Host "Firewall rule removed" -ForegroundColor Green
}

Write-Host ""
Write-Host "Uninstall complete" -ForegroundColor Green
