@echo off
rem ---------------------------------------------------------------------------
rem Repair the Windows ACL precondition that stops the DSH sandbox from
rem provisioning a session workspace.
rem
rem Symptom: agent tool calls fail with
rem   SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)
rem and the agent cannot run any command (so Office skills cannot either).
rem
rem Run with no arguments to check only. Add --fix to apply the grant.
rem Messages are ASCII on purpose: the console code page may be GBK.
rem ---------------------------------------------------------------------------
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-sandbox-acl.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo Result: OK ^(exit %CODE%^)
) else (
  echo Result: attention needed ^(exit %CODE%^)
)
pause
exit /b %CODE%
