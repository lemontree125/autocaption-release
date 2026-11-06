# updater.ps1 - AutoCaption auto-update apply step (started by server/updater.js)
#
# Runs as a separate, hidden process because it has to stop the server that started it.
#   1. stop the AutoCaption server processes that belong to -Root
#   2. back up Root\server and Root\plugin to Root\_backup
#   3. copy the downloaded files (-Staging) over Root
#   4. if the panel was installed as .ccx, reinstall it with Adobe's UPIA
#   5. start the server again and wait up to 40 s for /api/version to report -ToVersion
#   6. if that fails, restore the backup and start the old server
# Result: Root\update-status.json, log: Root\update.log
# Messages are English on purpose: Windows PowerShell 5.1 can misread non-ASCII text in scripts.

param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Staging,
    [string]$FromVersion = "",
    [string]$ToVersion = "",
    [int]$Port = 8934,
    [switch]$SkipPluginInstall
)
$ErrorActionPreference = "Stop"
$logPath = Join-Path $Root "update.log"
$statusPath = Join-Path $Root "update-status.json"
$serverDir = Join-Path $Root "server"
$pluginDir = Join-Path $Root "plugin"
$backupDir = Join-Path $Root "_backup"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Write-Status($ok, $message, $pluginNote) {
    $obj = [ordered]@{ ok = $ok; from = $FromVersion; to = $ToVersion; message = $message; plugin = $pluginNote; at = (Get-Date -Format "s") }
    $json = $obj | ConvertTo-Json
    [System.IO.File]::WriteAllText($statusPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Stop-ServerProcesses {
    $rootServer = $serverDir.ToLower()
    $self = $PID
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $self -and
        ($_.Name -eq "node.exe" -or $_.Name -eq "cmd.exe" -or $_.Name -eq "wscript.exe" -or $_.Name -eq "powershell.exe") -and $_.CommandLine -and (
            $_.CommandLine.ToLower().Contains($rootServer) -or
            $_.CommandLine -like "*AutoCaption-server.vbs*")
    }
    foreach ($p in $procs) {
        Log ("  stopping {0} {1}: {2}" -f $p.ProcessId, $p.Name, $p.CommandLine)
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    return @($procs).Count
}

function Start-Server {
    # v1.1.1~: PowerShell launcher instead of run-server-hidden.vbs (VBScript is being removed
    # from Windows; without it wscript shows "no script engine for .vbs" and nothing starts).
    $launcher = Join-Path $serverDir "start-server-hidden.ps1"
    $vbs = Join-Path $serverDir "run-server-hidden.vbs"
    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path -LiteralPath $launcher) {
        Start-Process -FilePath $psExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$launcher`"", "-Port", "$Port") -WindowStyle Hidden
    } elseif (Test-Path -LiteralPath $vbs) {
        Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbs`""
    } else {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$(Join-Path $serverDir 'start-server.bat')`"" -WindowStyle Hidden
    }
}

# Installs from v1.1.0 start the server at login with Startup\AutoCaption-server.vbs.
# Move them to the HKCU Run entry that install.ps1 (v1.1.1~) uses, so login works without VBScript.
function Update-AutoStart {
    $launcher = Join-Path $serverDir "start-server-hidden.ps1"
    if (-not (Test-Path -LiteralPath $launcher)) { return "launcher missing, autostart unchanged" }
    # Only the real install owns the login autostart (a test copy elsewhere must not rewrite it).
    $defaultRoot = Join-Path $env:LOCALAPPDATA "AutoCaption"
    if ($Root.TrimEnd('\') -ne $defaultRoot.TrimEnd('\')) { return "non-default root, autostart unchanged" }
    $startupVbs = Join-Path ([Environment]::GetFolderPath("Startup")) "AutoCaption-server.vbs"
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $existing = (Get-ItemProperty -Path $runKey -Name "AutoCaption Server" -ErrorAction SilentlyContinue)."AutoCaption Server"
    if (-not (Test-Path -LiteralPath $startupVbs) -and $existing) { return "autostart already uses Run key" }
    if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
    Set-ItemProperty -Path $runKey -Name "AutoCaption Server" -Value ("`"$psExe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"")
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $startupVbs
    return "autostart moved to Run key"
}

function Wait-ForVersion($expected, $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/version" -TimeoutSec 2
            if (-not $expected -or $r.current -eq $expected) { return $true }
        } catch { }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Copy-Tree($src, $dst, [switch]$Mirror) {
    $rcArgs = @($src, $dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:2", "/W:1")
    if ($Mirror) { $rcArgs += "/MIR" }
    & robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $src -> $dst" }
}

function Install-PanelCcx {
    $method = ""
    $mp = Join-Path $Root "install-method.txt"
    if (Test-Path -LiteralPath $mp) { $method = (Get-Content -LiteralPath $mp -Raw).Trim() }
    if ($method -ne "ccx") { return "manual install: reload the panel or restart Premiere Pro" }
    $sub = "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
    $upia = @($env:CommonProgramFiles, ${env:CommonProgramFiles(x86)}) | Where-Object { $_ } |
        ForEach-Object { Join-Path $_ $sub } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $upia) { return "UPIA not found: panel files updated, reinstall with install.bat if the panel looks old" }

    # Same unique-version trick as install.ps1: UPIA skips a package whose version it already has.
    $manifestPath = Join-Path $pluginDir "manifest.json"
    $raw = Get-Content -LiteralPath $manifestPath -Raw
    $epoch = Get-Date -Year 2026 -Month 1 -Day 1 -Hour 0 -Minute 0 -Second 0
    $ver = "1.{0}.{1}" -f [int]((Get-Date) - $epoch).TotalDays, [int]((Get-Date) - (Get-Date).Date).TotalMinutes
    $raw = $raw -replace '"version"\s*:\s*"[^"]*"', ('"version": "' + $ver + '"')
    [System.IO.File]::WriteAllText($manifestPath, $raw, (New-Object System.Text.UTF8Encoding($false)))

    $zip = Join-Path $env:TEMP "AutoCaption_update.zip"
    $ccx = Join-Path $env:TEMP "AutoCaption_update.ccx"
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $zip, $ccx
    Compress-Archive -Path (Join-Path $pluginDir "*") -DestinationPath $zip -Force
    Rename-Item -LiteralPath $zip -NewName (Split-Path $ccx -Leaf)
    $proc = Start-Process -FilePath $upia -ArgumentList @("/install", "`"$ccx`"") -Wait -PassThru -WindowStyle Hidden
    if ($proc.ExitCode -ne 0) { return "UPIA exit code $($proc.ExitCode): panel may still be the old version until install.bat is run" }
    return "panel reinstalled ($ver): restart Premiere Pro"
}

try { Start-Transcript -LiteralPath (Join-Path $Root "update-transcript.log") -Force | Out-Null } catch { }

try {
    Log "=== update $FromVersion -> $ToVersion start ==="
    Start-Sleep -Seconds 1  # let the server finish answering the panel
    $n = Stop-ServerProcesses
    Log "stopped $n server process(es)"

    if (Test-Path -LiteralPath $backupDir) { Remove-Item -Recurse -Force -LiteralPath $backupDir }
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Tree $serverDir (Join-Path $backupDir "server")
    Copy-Tree $pluginDir (Join-Path $backupDir "plugin")
    Log "backup done -> $backupDir"

    Copy-Tree $Staging $Root
    Log "new files copied"

    $pluginNote = "skipped"
    if (-not $SkipPluginInstall) {
        try { $pluginNote = Install-PanelCcx } catch { $pluginNote = "panel reinstall error: $($_.Exception.Message)" }
    }
    Log "panel: $pluginNote"

    try { Log ("autostart: " + (Update-AutoStart)) } catch { Log "autostart update error: $($_.Exception.Message)" }

    Start-Server
    if (Wait-ForVersion $ToVersion 40) {
        Log "server is up on $ToVersion"
        Write-Status $true "updated to $ToVersion" $pluginNote
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $Staging
        exit 0
    }
    throw "new server did not answer within 40 seconds"
} catch {
    $err = $_.Exception.Message
    Log "FAILED: $err - rolling back"
    try {
        Stop-ServerProcesses | Out-Null
        if (Test-Path -LiteralPath (Join-Path $backupDir "server")) {
            Copy-Tree (Join-Path $backupDir "server") $serverDir -Mirror
            Copy-Tree (Join-Path $backupDir "plugin") $pluginDir -Mirror
            Log "rollback restored $FromVersion files"
        }
        # The restored (older) version has no PowerShell launcher: put the old login autostart back.
        $isDefaultRoot = ($Root.TrimEnd('\') -eq (Join-Path $env:LOCALAPPDATA "AutoCaption").TrimEnd('\'))
        if ($isDefaultRoot -and -not (Test-Path -LiteralPath (Join-Path $serverDir "start-server-hidden.ps1"))) {
            $oldVbs = Join-Path $serverDir "run-server-hidden.vbs"
            if (Test-Path -LiteralPath $oldVbs) {
                Copy-Item -Force -LiteralPath $oldVbs -Destination (Join-Path ([Environment]::GetFolderPath("Startup")) "AutoCaption-server.vbs")
                Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "AutoCaption Server" -ErrorAction SilentlyContinue
                Log "rollback restored old autostart (Startup vbs)"
            }
        }
        Start-Server
        if (Wait-ForVersion $FromVersion 40) { Log "old server is up again" } else { Log "old server did not answer either" }
    } catch {
        Log "rollback error: $($_.Exception.Message)"
    }
    Write-Status $false "update failed, rolled back to $FromVersion : $err" ""
    exit 1
}
