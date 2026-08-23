@echo off
setlocal EnableExtensions

rem One-click installer for the Mixly 2/3 DeepSeek Harness client.
cd /d "%~dp0"
rem The trailing dot avoids the Windows quoted-path/backslash parsing trap.
set "MCP_SOURCE=%~dp0."

set "NODE_CMD="
where node >nul 2>nul
if not errorlevel 1 set "NODE_CMD=node"
if not defined NODE_CMD if exist "%LOCALAPPDATA%\MixlyHarness\runtime\node\node.exe" set "NODE_CMD=%LOCALAPPDATA%\MixlyHarness\runtime\node\node.exe"
if not defined NODE_CMD goto no_node
"%NODE_CMD%" -e "const major=Number(process.versions.node.split('.')[0]);process.exit(major>=18?0:1)" >nul 2>nul
if errorlevel 1 goto no_node

echo Mixly 2 / 3 AI installer
echo Scanning the installer folder and its parent folders for Mixly installations...

rem When the release folder is placed below a Mixly directory, use that root
rem automatically. This covers the common ...\Mixly_Local_MCP_vX\MixlyLocalMCP layout.
for %%P in ("%~dp0.." "%~dp0..\.." "%~dp0..\..\.." "%~dp0..\..\..\..") do (
  if not defined MIXLY2_HOME if exist "%%~fP\resources\app\src\boards\index.html" set "MIXLY2_HOME=%%~fP"
  if not defined MIXLY3_HOME if exist "%%~fP\boards\index.html" (
    if not exist "%%~fP\package.json" set "MIXLY3_HOME=%%~fP"
    if exist "%%~fP\package.json" findstr /i /c:"static-server/server.js" "%%~fP\package.json" >nul || set "MIXLY3_HOME=%%~fP"
  )
)
if defined MIXLY2_HOME echo Detected Mixly 2: %MIXLY2_HOME%
if defined MIXLY3_HOME echo Detected Mixly 3: %MIXLY3_HOME%

if not defined MIXLY2_HOME if not defined MIXLY3_HOME (
  echo Mixly 2/3 was not detected automatically.
  set /p "MIXLY2_HOME=Mixly 2 full path (blank to skip): "
  set /p "MIXLY3_HOME=Mixly 3 full path (blank to skip): "
)

if not defined MIXLY2_HOME if not defined MIXLY3_HOME (
  echo At least one Mixly 2 or Mixly 3 path is required.
  pause
  exit /b 2
)

set "MIXLY2_ARG="
set "MIXLY3_ARG="
if defined MIXLY2_HOME (
  for %%I in ("%MIXLY2_HOME%") do set "MIXLY2_HOME=%%~fI"
  if not exist "%MIXLY2_HOME%\resources\app\src\boards\index.html" (
    echo Invalid Mixly 2 path: %MIXLY2_HOME%
    echo The path must contain resources\app\src\boards\index.html.
    pause
    exit /b 2
  )
  set MIXLY2_ARG=--mixly2-home "%MIXLY2_HOME%"
)
if defined MIXLY3_HOME (
  for %%I in ("%MIXLY3_HOME%") do set "MIXLY3_HOME=%%~fI"
  if not exist "%MIXLY3_HOME%\boards\index.html" (
    echo Invalid Mixly 3 path: %MIXLY3_HOME%
    echo The path must contain boards\index.html.
    pause
    exit /b 2
  )
  set MIXLY3_ARG=--mixly3-home "%MIXLY3_HOME%"
)

echo Installing portable Node.js and DeepSeek Harness. Network access may be required.
"%NODE_CMD%" "%MCP_SOURCE%\harness_integration\install.js" --mcp-source "%MCP_SOURCE%" %MIXLY2_ARG% %MIXLY3_ARG%
if errorlevel 1 (
  echo Installation failed. Review the error above and run this file again after fixing it.
  pause
  exit /b 1
)

echo.
echo Mixly 2 / 3 installation complete.
echo Close and reopen each selected Mixly application once so its AI toolbar button is loaded.
pause
exit /b 0

:no_node
echo Node.js 18 or newer was not found in PATH or the existing Harness runtime.
echo Install Node.js from https://nodejs.org/ and run this file again.
pause
exit /b 2
