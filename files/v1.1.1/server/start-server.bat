@echo off
rem Korean text inside a rem comment line previously caused cmd.exe to
rem misparse the file on some PCs (console codepage mismatch), so this
rem file is kept ASCII-only on purpose - do not add Korean comments here.
echo === AutoCaption Local Server ===
where node >nul 2>nul
if errorlevel 1 goto no_node
goto check_python

:no_node
echo.
echo [ERROR] Node.js is not installed.
pause
exit /b 1

:check_python
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 goto no_python
python "%~dp0pipeline\patch_av_compat.py"
goto run

:no_python
echo [AutoCaption] python not found - skipping av compat auto-patch.
goto run

:run
rem Must run with the absolute path (not "node server.js"), so the
rem running process shows "AutoCaption" in its command line - this is
rem what install.ps1/uninstall.ps1 use to find and stop old servers.
node "%~dp0server.js"
pause
