$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePython = Join-Path $projectRoot 'work\ocr-runtime\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) { throw '请先运行 scripts/setup-ocr.ps1 安装本地OCR组件。' }
if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) {
    Write-Output '8765端口已有服务。若为本项目OCR，可直接选择 work/ocr-connection.json；否则请检查端口占用。'
    exit
}
$ocrProcess = Start-Process -FilePath $runtimePython -ArgumentList @('-X', 'utf8', '-u', '-m', 'local_ocr.server') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'work\ocr-service.log') -RedirectStandardError (Join-Path $projectRoot 'work\ocr-service-error.log') -PassThru
Set-Content -LiteralPath (Join-Path $projectRoot 'work\ocr-service.pid') -Value $ocrProcess.Id
Write-Output '本地OCR正在启动；就绪状态见 work/ocr-service.log。随后在助手选择 work/ocr-connection.json。'
