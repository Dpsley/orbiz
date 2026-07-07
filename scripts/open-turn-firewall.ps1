param(
  [int]$TurnPort = 3478,
  [int]$RelayMinPort = 56234,
  [int]$RelayMaxPort = 56284,
  [string]$RemoteAddress = "15.8.0.0/24"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as Administrator."
}

$rules = @(
  @{
    Name = "Orbiz TURN UDP $TurnPort"
    Protocol = "UDP"
    Port = "$TurnPort"
  },
  @{
    Name = "Orbiz TURN TCP $TurnPort"
    Protocol = "TCP"
    Port = "$TurnPort"
  },
  @{
    Name = "Orbiz TURN Relay UDP $RelayMinPort-$RelayMaxPort"
    Protocol = "UDP"
    Port = "$RelayMinPort-$RelayMaxPort"
  }
)

foreach ($ruleInfo in $rules) {
  $rule = Get-NetFirewallRule -DisplayName $ruleInfo.Name -ErrorAction SilentlyContinue

  if ($rule) {
    Remove-NetFirewallRule -DisplayName $ruleInfo.Name | Out-Null
  }

  New-NetFirewallRule `
    -DisplayName $ruleInfo.Name `
    -Direction Inbound `
    -Action Allow `
    -Protocol $ruleInfo.Protocol `
    -LocalPort $ruleInfo.Port `
    -Profile Any `
    -RemoteAddress $RemoteAddress `
    -Description "Allows TURN relay traffic for Orbiz WebRTC screen sharing." | Out-Null

  Write-Host "Firewall rule is enabled: $($ruleInfo.Name)"
}
