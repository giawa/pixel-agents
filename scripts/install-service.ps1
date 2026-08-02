param(
    [Parameter(Mandatory=$true)]
    [int]$Port,
    
    [Parameter(Mandatory=$true)]
    [string]$Token,
    
    [Parameter(Mandatory=$true)]
    [string]$NssmPath,
    
    [string]$BindAddress = "0.0.0.0",
    
    [string]$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source,
    
    [string]$ServiceName = "PixelAgents"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CliPath = Join-Path $ProjectRoot "dist\cli.js"
$LogDir = Join-Path $ProjectRoot "logs"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script must be run as Administrator to create firewall rules and install services."
    exit 1
}

if (-not (Test-Path $NssmPath)) {
    Write-Error "NSSM not found at: $NssmPath"
    exit 1
}

if (-not $NodePath -or -not (Test-Path $NodePath)) {
    Write-Error "Node.js not found. Please install Node.js or specify -NodePath parameter."
    exit 1
}

if (-not (Test-Path $CliPath)) {
    Write-Error "CLI not found at: $CliPath. Please build the project first (npm run build)."
    exit 1
}

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

Write-Host "Installing service: $ServiceName" -ForegroundColor Cyan
Write-Host "  Node: $NodePath"
Write-Host "  CLI: $CliPath"
Write-Host "  Bind: $BindAddress`:$Port"
Write-Host "  Logs: $LogDir"
Write-Host ""

$AppArgs = "`"$CliPath`" --port $Port --host $BindAddress --token $Token"
$App = "`"$NodePath`""

& $NssmPath install $ServiceName $App $AppArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install service"
    exit 1
}

& $NssmPath set $ServiceName AppDirectory $ProjectRoot
& $NssmPath set $ServiceName AppExit Default Restart
& $NssmPath set $ServiceName AppRestartDelay 5000
& $NssmPath set $ServiceName AppStdout (Join-Path $LogDir "pixel-agents-stdout.log")
& $NssmPath set $ServiceName AppStderr (Join-Path $LogDir "pixel-agents-stderr.log")
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName DisplayName "Pixel Agents Server"
& $NssmPath set $ServiceName Description "Pixel Agents standalone server for AI agent visualization"

Write-Host "Service installed successfully" -ForegroundColor Green
Write-Host ""

$firewallRuleName = "PixelAgents-Port$Port"
Write-Host "Creating firewall rule: $firewallRuleName" -ForegroundColor Cyan
New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
Write-Host "Firewall rule created" -ForegroundColor Green
Write-Host ""

Write-Host "Starting service..." -ForegroundColor Cyan
& $NssmPath start $ServiceName
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Service installed but failed to start. Check logs at: $LogDir"
    exit 1
}

Start-Sleep -Seconds 2

$status = & $NssmPath status $ServiceName
Write-Host "Service status: $status" -ForegroundColor Green
Write-Host ""

if ($BindAddress -eq "0.0.0.0") {
    $localIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -ne "127.0.0.1" } | Select-Object -First 1).IPAddress
    Write-Host "Service is running. Access the dashboard at:" -ForegroundColor Green
    Write-Host "  Local:   http://localhost:$Port" -ForegroundColor White
    if ($localIp) {
        Write-Host "  Network: http://$localIp`:$Port" -ForegroundColor White
    }
} else {
    Write-Host "Service is running. Access the dashboard at: http://$BindAddress`:$Port" -ForegroundColor Green
}
Write-Host ""
Write-Host "To uninstall: .\scripts\uninstall-service.ps1 -NssmPath `"$NssmPath`"" -ForegroundColor Gray
