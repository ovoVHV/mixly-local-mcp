@echo off
setlocal EnableExtensions

rem One-click installer for the Mixly 4 DeepSeek Harness client.
cd /d "%~dp0"
rem The trailing dot avoids the Windows quoted-path/backslash parsing trap.
set "MCP_SOURCE=%~dp0."
set "DEFAULT_MIXLY4=%~dp0.."
if not exist "%DEFAULT_MIXLY4%\boards\index.html" set "DEFAULT_MIXLY4="

set "NODE_CMD="
where node >nul 2>nul
if not errorlevel 1 set "NODE_CMD=node"
if defined NODE_CMD (
  "%NODE_CMD%" -e "const major=Number(process.versions.node.split('.')[0]);process.exit(major>=18?0:1)" >nul 2>nul
  if errorlevel 1 set "NODE_CMD="
)
if not defined NODE_CMD if exist "%LOCALAPPDATA%\MixlyHarness\runtime\node\node.exe" set "NODE_CMD=%LOCALAPPDATA%\MixlyHarness\runtime\node\node.exe"
if defined NODE_CMD (
  "%NODE_CMD%" -e "const major=Number(process.versions.node.split('.')[0]);process.exit(major>=18?0:1)" >nul 2>nul
  if errorlevel 1 set "NODE_CMD="
)

echo Mixly 4 AI installer
if defined DEFAULT_MIXLY4 (
  set "MIXLY4_HOME=%DEFAULT_MIXLY4%"
  echo Detected Mixly 4: %DEFAULT_MIXLY4%
) else (
  set /p "MIXLY4_HOME=Mixly 4 full path (blank to skip): "
)

if not defined MIXLY4_HOME (
  echo No Mixly 4 path was selected. Skipping this installer.
  pause
  exit /b 0
)
for %%I in ("%MIXLY4_HOME%") do set "MIXLY4_HOME=%%~fI"
if not exist "%MIXLY4_HOME%\boards\index.html" (
  echo Invalid Mixly 4 path: %MIXLY4_HOME%
  echo The path must contain boards\index.html.
  pause
  exit /b 2
)

if not defined NODE_CMD goto no_node
echo Installing portable Node.js and DeepSeek Harness. Network access may be required.
"%NODE_CMD%" "%MCP_SOURCE%\harness_integration\install.js" --mcp-source "%MCP_SOURCE%" --mixly4-home "%MIXLY4_HOME%"
if errorlevel 1 (
  echo Installation failed. Review the error above and run this file again after fixing it.
  pause
  exit /b 1
)

echo.
echo Mixly 4 installation complete.
echo Close and reopen Mixly 4 once so the AI toolbar button is loaded.
pause
exit /b 0

:no_node
echo Node.js 18 or newer was not found in PATH or the existing Harness runtime.
echo Install Node.js from https://nodejs.org/ and run this file again.
pause
exit /b 2
