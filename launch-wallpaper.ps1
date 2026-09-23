[CmdletBinding()]
param(
  [string]$ImagePath,
  [int]$Port = 9335,
  [ValidateRange(0, 1)][double]$Opacity = 0.27,
  [switch]$LaunchIfNeeded,
  [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$scriptPath = Join-Path $root 'src\wallpaper.mjs'
$defaultImagePath = [System.IO.Path]::GetFullPath((Join-Path $root 'assets\background.png'))
if ([string]::IsNullOrWhiteSpace($ImagePath)) { $ImagePath = $defaultImagePath }
$codex = Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1
$codexExe = Join-Path $codex.InstallLocation 'app\ChatGPT.exe'

if (-not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) {
  throw "Wallpaper image not found: $ImagePath"
}
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw "Injector script not found: $scriptPath"
}
if (-not (Test-Path -LiteralPath $codexExe -PathType Leaf)) {
  throw "Official Codex executable not found: $codexExe"
}

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [System.Threading.Mutex]::new($false, "Local\CodexLocalWallpaper.$sid")
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'Another local wallpaper injection is already running.' }

  $arguments = @(
    $scriptPath,
    '--image', $ImagePath,
    '--port', "$Port",
    '--opacity', "$Opacity"
  )
  if ($LaunchIfNeeded) {
    $arguments += @('--launch', '--codex-exe', $codexExe)
  }
  if ($ProfilePath) {
    $arguments += @('--profile-path', ([System.IO.Path]::GetFullPath($ProfilePath)))
  }
  & $node @arguments
  exit $LASTEXITCODE
} finally {
  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
