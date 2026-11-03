$ErrorActionPreference = 'Stop'
$upstream = Join-Path (Join-Path $PSScriptRoot 'runtime') 'upstream'
$node = (Get-Command node.exe -ErrorAction Stop).Source
Set-Location $upstream
Write-Host 'Sign in to your own DeepSeek account in the Chrome window.'
Write-Host 'Your login is saved locally under runtime\upstream, never in this GitHub repository.'
& $node 'scripts/deepseek_chrome_auth.js'
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Login failed. Review the Chrome window and try again.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
