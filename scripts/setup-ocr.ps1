param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot 'work\ocr-runtime'
$runtimePython = Join-Path $runtimeRoot 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    & $Python -m venv $runtimeRoot
    if ($LASTEXITCODE -ne 0) { throw '创建本地OCR环境失败；需要Python 3.12。' }
}
& $runtimePython -m pip install -r (Join-Path $projectRoot 'local_ocr\requirements-lock.txt')
if ($LASTEXITCODE -ne 0) { throw '安装本地OCR依赖失败。' }
Push-Location $projectRoot
try {
    & $runtimePython -m local_ocr.server --prepare-only
    if ($LASTEXITCODE -ne 0) { throw 'OCR模型准备失败。' }
} finally { Pop-Location }
Write-Output '准备完成。运行 scripts/start-ocr.ps1 启动本地组件。'
