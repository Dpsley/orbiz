$ErrorActionPreference = "Stop"
$containerName = "orbiz-coturn"

$ErrorActionPreference = "Continue"
docker rm -f $containerName 2>$null | Out-Null
$ErrorActionPreference = "Stop"
Write-Host "Coturn Docker container is stopped: $containerName"
