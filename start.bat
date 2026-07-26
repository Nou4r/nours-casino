@echo off
cd /d "%~dp0"
title Nour's Casino - Provably Fair Originals Suite
cls
echo ============================================================
echo   Nour's Casino - Provably Fair Originals Suite
echo ============================================================
echo.
echo Launching local server at http://localhost:8080 ...
echo Press Ctrl+C in this window to stop the server when done.
echo.

rem Open default browser window to the game suite
start "" "http://localhost:8080/index.html"

rem Start Python HTTP server using py launcher if available, falling back to python
where py >nul 2>nul && (py -3 -m http.server 8080) || (python -m http.server 8080)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Server failed to start. Ensure Python is installed and added to PATH.
    pause
)
