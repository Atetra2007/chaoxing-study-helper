$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'work\ocr-service.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output '没有由启动脚本记录的OCR进程。'; exit }
$ocrPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$ocrProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ocrPid" -ErrorAction SilentlyContinue
$expectedPython = Join-Path $projectRoot 'work\ocr-runtime\Scripts\python.exe'
if (-not $ocrProcess) { Write-Output '本地OCR已经停止。'; exit }
if ($ocrProcess.ExecutablePath -ne $expectedPython -or $ocrProcess.CommandLine -notmatch '\s-m\s+local_ocr\.server(?:\s|$)') {
    throw '进程信息与本项目OCR不符，未停止任何进程。'
}
Stop-Process -Id $ocrPid
Write-Output '本地OCR已停止。普通图片保存不受影响。'
