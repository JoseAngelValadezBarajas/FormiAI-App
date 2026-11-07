<#
Starts one FormiAI backend against an isolated preview root (data\<Name>\{research,store,cache,config}).
  powershell -ExecutionPolicy Bypass -File scripts\start-preview-backend.ps1 -Name real-preview -Port 8011
Everything the analysis needs is set here, so a restart cannot silently lose it:
  UV_PROJECT_ENVIRONMENT / UV_NO_SYNC  use the Ants-2 environment as-is (previews have no src\ to build)
  FORMIAI_V2_E2_CHECKPOINT             the verified V2-E2 checkpoint (SHA-256 is still checked by the backend)
It first proves that `uv run` can import formicai from the preview root and refuses to start otherwise.
Nothing is written to Ants-2 (bytecode writing is disabled for the probe and the backend).
#>
param(
  [Parameter(Mandatory)] [string] $Name,
  [Parameter(Mandatory)] [int] $Port,
  [string] $Ants = 'C:\Dev\Ants-2',
  [string] $Device = 'cuda:0'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repo "data\$Name"
foreach ($folder in 'research', 'store', 'cache', 'config') { if (-not (Test-Path (Join-Path $root $folder))) { throw "Missing $root\$folder" } }
$checkpoint = Join-Path $repo 'data\v2-preview\research\v2-e2-epoch45.pt'

Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
$env:UV_PROJECT_ENVIRONMENT = Join-Path $Ants '.venv'
$env:UV_NO_SYNC = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:UV_CACHE_DIR = Join-Path $root 'cache'
$env:YOLO_CONFIG_DIR = Join-Path $root 'config'
$env:FORMIAI_RESEARCH_ROOT = (Join-Path $root 'research').Replace([string][char]92, '/')
$env:FORMIAI_DATA_DIR = (Join-Path $root 'store').Replace([string][char]92, '/')
$env:FORMIAI_DEVICE = $Device
$env:FORMIAI_V2_E2_CHECKPOINT = $checkpoint

Push-Location (Join-Path $root 'research')
try {
  $probe = & uv run python -c "import formicai, sys; print(formicai.__file__)" 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (($probe | Select-Object -Last 1).ToString().StartsWith($Ants, [StringComparison]::OrdinalIgnoreCase))) { throw "uv cannot import formicai from the Ants-2 environment:`n$probe" }
} finally { Pop-Location }

$logs = Join-Path $root 'logs'; New-Item -ItemType Directory -Force $logs | Out-Null
Start-Process -FilePath (Join-Path $repo 'backend\.venv\Scripts\python.exe') -WorkingDirectory (Join-Path $repo 'backend') -WindowStyle Hidden `
  -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', $Port `
  -RedirectStandardOutput (Join-Path $logs "backend-$Port.out.log") -RedirectStandardError (Join-Path $logs "backend-$Port.err.log")
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try { $models = Invoke-RestMethod "http://127.0.0.1:$Port/api/models" -TimeoutSec 5; break } catch { }
}
if (-not $models) { throw "Backend on port $Port did not answer /api/models; see $logs" }
$models.models | ForEach-Object { "{0}: {1} available={2} {3}" -f $Port, $_.id, $_.available, $_.reason }
