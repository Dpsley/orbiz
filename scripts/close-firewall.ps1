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
  Disable-NetFirewallRule -DisplayName $ruleName | Out-Null
  Write-Host "Firewall rule is disabled: $ruleName"
} else {
  Write-Host "Firewall rule was not found: $ruleName"
}
