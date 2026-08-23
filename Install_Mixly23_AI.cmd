@echo off
setlocal EnableExtensions

rem One-click installer for the Mixly 2/3 DeepSeek Harness client.
cd /d "%~dp0"
rem The trailing dot avoids the Windows quoted-path/backslash parsing trap.
set "MCP_SOURCE=%~dp0."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required to run the installer.
  echo Install Node.js from https://nodejs.org/ and run this file again.
  pause
  exit /b 2
)

echo Mixly 2 / 3 AI installer
echo Leave a version path empty to skip that generation.
set /p "MIXLY2_HOME=Mixly 2 full path (blank to skip): "
set /p "MIXLY3_HOME=Mixly 3 full path (blank to skip): "

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
node "%MCP_SOURCE%\harness_integration\install.js" --mcp-source "%MCP_SOURCE%" %MIXLY2_ARG% %MIXLY3_ARG%
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
