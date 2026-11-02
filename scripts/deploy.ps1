$ErrorActionPreference = 'Stop'

$source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$destination = '\\192.168.1.40\ffmpeg\server'

if (-not (Test-Path -LiteralPath $destination)) {
    throw "Cannot access deployment destination: $destination"
}

Write-Host "Deploying to $destination ..."

& robocopy $source $destination /E /XD (Join-Path $source 'node_modules') (Join-Path $source '.git') /XF 'deploy.log'
$robocopyExitCode = $LASTEXITCODE

if ($robocopyExitCode -ge 8) {
    throw "robocopy failed (exit code: $robocopyExitCode)"
}

Write-Host "Deploy completed (robocopy exit code: $robocopyExitCode)"
Write-Host "Note: run 'npm ci --omit=dev' and 'pm2 restart ffmpegServer' on 192.168.1.40 if dependencies are not ready"