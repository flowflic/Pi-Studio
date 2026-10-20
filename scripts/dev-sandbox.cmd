@echo off
rem ---------------------------------------------------------------------------
rem Launch Pi Studio in development mode with all writable state kept inside
rem this repository. Use this when running from a confined host (for example a
rem sandboxed agent shell) where Electron cannot write to %APPDATA% or %TEMP%:
rem Chromium would fail to create its single-instance lock and no window opens.
rem
rem Normal local development does not need this file - use `npm run dev`.
rem ---------------------------------------------------------------------------
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%" || exit /b 1

rem Electron must run as Electron, not as Node.
set "ELECTRON_RUN_AS_NODE="
rem Chromium sandbox/GPU initialisation is unavailable in restricted sessions.
set "NO_SANDBOX=1"
set ELECTRON_CLI_ARGS=["--disable-gpu"]

if not defined PI_STUDIO_USER_DATA set "PI_STUDIO_USER_DATA=%ROOT%\.dev-sandbox\user-data"
if not defined PI_CODING_AGENT_DIR set "PI_CODING_AGENT_DIR=%ROOT%\.dev-sandbox\agent"
set "PI_AGENT_DIR=%PI_CODING_AGENT_DIR%"
set "TMP=%ROOT%\.dev-sandbox\temp"
set "TEMP=%TMP%"

if not exist "%PI_STUDIO_USER_DATA%" mkdir "%PI_STUDIO_USER_DATA%"
if not exist "%PI_CODING_AGENT_DIR%" mkdir "%PI_CODING_AGENT_DIR%"
if not exist "%TMP%" mkdir "%TMP%"

echo Pi Studio dev (sandboxed profile)
echo   userData : %PI_STUDIO_USER_DATA%
echo   agent dir: %PI_CODING_AGENT_DIR%
echo.
call npm run dev
set "EXIT=%ERRORLEVEL%"
popd
exit /b %EXIT%
