@echo off
rem ============================================================
rem  Push cloud-dashboard to GitHub  (SSH, no password needed)
rem  ASCII-only on purpose: Chinese text in .bat gets garbled
rem  by cmd.exe codepage 936. Do NOT add non-ASCII chars here.
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo:
echo:  ==========================================
echo:    cloud-dashboard  -  push to GitHub
echo:  ==========================================
echo:

set "MSG=%~1"
if not defined MSG set "MSG=update"

echo:  [1/3] git add -A
git add -A

echo:  [2/3] git commit -m "%MSG%"
git commit -m "%MSG%"
if errorlevel 1 echo:  NOTE - nothing new to commit, continue to push.

echo:  [3/3] git push origin master
git push origin master
if errorlevel 1 goto fail

echo:
echo:  DONE. Pushed to GitHub.
echo:
pause
exit /b 0

:fail
echo:
echo:  PUSH FAILED. See the message above.
echo:
pause
exit /b 1
