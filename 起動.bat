@echo off
cd /d "%~dp0"

rem Start the server in a hidden window if port 8080 is not already listening
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'python' -ArgumentList '-m','http.server','8080' -WorkingDirectory '%~dp0' -WindowStyle Hidden } "

start "" http://localhost:8080
