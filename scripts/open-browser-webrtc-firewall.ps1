param(
  [string]$RemoteAddress = "Any"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as Administrator."
}

$browserPaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
  "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

if (-not $browserPaths) {
  throw "No supported browser executable was found."
}

foreach ($path in $browserPaths) {
  $name = "Orbiz WebRTC Browser $([IO.Path]::GetFileNameWithoutExtension($path))"
  $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue

  if ($rule) {
    Remove-NetFirewallRule -DisplayName $name | Out-Null
  }

  New-NetFirewallRule `
    -DisplayName $name `
    -Direction Inbound `
    -Action Allow `
    -Program $path `
    -Profile Any `
    -RemoteAddress $RemoteAddress `
    -Description "Allows browser WebRTC media traffic for Orbiz screen sharing." | Out-Null

  Write-Host "Firewall rule is enabled for: $path"
}
