param(
  [int]$Port = 8152
)

$ErrorActionPreference = "Stop"
$ruleName = "Orbiz Screen Share TCP $Port"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as Administrator."
}

$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($rule) {
  Enable-NetFirewallRule -DisplayName $ruleName | Out-Null
} else {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Any `
    -Description "Allows remote viewers to connect to the Orbiz screen sharing server." | Out-Null
}

Write-Host "Firewall rule is enabled: $ruleName"
