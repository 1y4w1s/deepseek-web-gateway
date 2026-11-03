$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$upstream = Join-Path $runtime 'upstream'
$log = Join-Path $runtime 'launcher.log'
$dashboard = 'http://127.0.0.1:9655/dashboard'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

function Test-DeepSeekHealth {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:9655/health' -TimeoutSec 2
        return $health.service -eq 'FreeDeepseekAPI'
    } catch {
        return $false
    }
}

try {
    if (Test-DeepSeekHealth) {
        Start-Process $dashboard
        return
    }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    if (-not (Test-Path (Join-Path $upstream 'server.js'))) {
        if (Test-Path $upstream) {
            throw 'Incomplete runtime\upstream directory. Refusing to overwrite it.'
        }
        $git = (Get-Command git.exe -ErrorAction Stop).Source
        $args = 'clone --branch stable --depth 1 https://github.com/dekrezz/FreeDeepseekAPI.git "' + $upstream + '"'
        $clone = Start-Process -FilePath $git -ArgumentList $args -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $runtime 'git.stdout.log') -RedirectStandardError (Join-Path $runtime 'git.stderr.log')
        if ($clone.ExitCode -ne 0) {
            throw 'Clone failed. Inspect runtime\git.stderr.log.'
        }
    }

    if (-not (Test-Path (Join-Path $upstream 'deepseek-auth.json'))) {
        $authScript = Join-Path $root 'Authenticate.ps1'
        $authArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $authScript + '"'
        $auth = Start-Process -FilePath 'powershell.exe' -ArgumentList $authArgs -PassThru -Wait
        if ($auth.ExitCode -ne 0 -or -not (Test-Path (Join-Path $upstream 'deepseek-auth.json'))) {
            throw 'DeepSeek account sign-in was not completed.'
        }
    }

    $compat = Join-Path $root 'patches\apply-upstream.cjs'
    $compatArgs = '"' + $compat + '" "' + $upstream + '"'
    $patched = Start-Process -FilePath $node -ArgumentList $compatArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $runtime 'patch.stdout.log') -RedirectStandardError (Join-Path $runtime 'patch.stderr.log')
    if ($patched.ExitCode -ne 0) {
        throw 'Compatibility patch could not be applied. Inspect runtime\patch.stderr.log.'
    }

    # Node fetch does not automatically inherit Chrome's Windows system HTTP proxy.
    $windowsProxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ([int]$windowsProxy.ProxyEnable -eq 1 -and [string]$windowsProxy.ProxyServer -match '^(?:127\.0\.0\.1|localhost):(\d+)$') {
        $proxyUrl = 'http://127.0.0.1:' + $Matches[1]
        $env:HTTPS_PROXY = $proxyUrl
        $env:HTTP_PROXY = $proxyUrl
        $env:NO_PROXY = 'localhost,127.0.0.1'
        $env:NODE_USE_ENV_PROXY = '1'
    }

    $env:HOST = '127.0.0.1'
    $env:PORT = '9655'
    $env:NON_INTERACTIVE = '1'
    $env:SKIP_ACCOUNT_MENU = '1'
    $server = Start-Process -FilePath $node -ArgumentList 'scripts/start.js' -WorkingDirectory $upstream -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'server.stdout.log') -RedirectStandardError (Join-Path $runtime 'server.stderr.log')
    $server.Id | Set-Content (Join-Path $runtime 'server.pid')

    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-DeepSeekHealth) { $ready = $true; break }
        if ($server.HasExited) { break }
    }
    if (-not $ready) {
        throw 'Local API did not become ready. Inspect runtime\server.stderr.log.'
    }
    Start-Process $dashboard
} catch {
    ('[' + (Get-Date -Format 's') + '] ' + $_.Exception.Message) | Add-Content $log
    Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $log + '"')
}
