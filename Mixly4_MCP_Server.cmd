@echo off
if not defined MIXLY_HOME if defined MIXLY4_HOME set "MIXLY_HOME=%MIXLY4_HOME%"
if not defined MIXLY_HOME (
  echo MIXLY_HOME is required. Set it to the Mixly 4 installation root. 1>&2
  exit /b 2
)
node "%~dp0mixly_mcp_server.js"
