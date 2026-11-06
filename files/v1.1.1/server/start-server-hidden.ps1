# start-server-hidden.ps1 - start the AutoCaption server with no visible window.
#
# Used at login (HKCU ...\Run "AutoCaption Server"), by install.ps1 and by updater.ps1.
# Replaces run-server-hidden.vbs: Windows is phasing out VBScript, and on PCs without it
# (Windows Sandbox, newer Windows 11 builds) wscript showed "no script engine for .vbs"
# and the server never started.
# ASCII only on purpose: Windows PowerShell 5.1 can misread non-ASCII text in scripts.
param([int]$Port = 8934)
$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

# Already running? Then do nothing (login + install can both try to start it).
try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/ping" -TimeoutSec 2
    exit 0
} catch { }

# PATH at login can miss tools installed a moment ago by winget, so also look in the usual places.
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User") + ";" +
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links")
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) {
    foreach ($c in @((Join-Path $env:ProgramFiles "nodejs\node.exe"), (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"))) {
        if (Test-Path -LiteralPath $c) { $node = $c; break }
    }
}
if (-not $node) {
    Add-Content -LiteralPath (Join-Path $here "server.log") -Value ("[{0}] start-server-hidden: node.exe not found" -f (Get-Date -Format s)) -Encoding UTF8
    exit 1
}

# Same av-compat patch start-server.bat runs (safe to run every time; it skips if already done).
$py = Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1
if ($py -and $py.Source -notlike "*\WindowsApps\*") {
    try {
        Start-Process -FilePath $py.Source -ArgumentList ('"' + (Join-Path $here "pipeline\patch_av_compat.py") + '"') `
            -WorkingDirectory $here -WindowStyle Hidden -Wait
    } catch { }
}

# Absolute path to server.js on purpose: install/uninstall/updater find the running server
# by "AutoCaption...server.js" in its command line.
# Non-default port (tests): server.js reads AUTOCAPTION_PORT, and node inherits this process's env.
if ($Port -ne 8934) { $env:AUTOCAPTION_PORT = "$Port" }
Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $here "server.js") + '"') -WorkingDirectory $here -WindowStyle Hidden
exit 0
