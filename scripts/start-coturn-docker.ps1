param(
  [string]$HostIp = "15.8.0.2",
  [int]$TurnPort = 3478,
  [int]$RelayMinPort = 56234,
  [int]$RelayMaxPort = 56284,
  [string]$Username = "orbiz",
  [string]$Password = "orbiz-turn"
)

$ErrorActionPreference = "Stop"
$containerName = "orbiz-coturn"

$ErrorActionPreference = "Continue"
docker rm -f $containerName 2>$null | Out-Null
$ErrorActionPreference = "Stop"

$containerId = docker run -d `
  --name $containerName `
  -p "${TurnPort}:${TurnPort}/udp" `
  -p "${TurnPort}:${TurnPort}/tcp" `
  -p "${RelayMinPort}-${RelayMaxPort}:${RelayMinPort}-${RelayMaxPort}/udp" `
  coturn/coturn:latest `
  --no-cli `
  --listening-port=$TurnPort `
  --tls-listening-port=5349 `
  --min-port=$RelayMinPort `
  --max-port=$RelayMaxPort `
  --lt-cred-mech `
  --user="${Username}:${Password}" `
  --realm=orbiz.local `
  --external-ip=$HostIp `
  --fingerprint `
  --verbose

if ($LASTEXITCODE -ne 0) {
  throw "Failed to start coturn Docker container."
}

$containerId | Out-Host

Write-Host "Coturn Docker container is running: $containerName"
Write-Host "TURN: $HostIp`:$TurnPort, relay UDP $RelayMinPort-$RelayMaxPort"
