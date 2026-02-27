@echo off
:: Antigravity Debug Mode Launcher
:: Opens Antigravity with remote debugging enabled so AG Phone Connect can see it.
:: Usage: antigravity-debug.bat [folder_path]
:: Example: antigravity-debug.bat C:\Proyects\juby-web
::          antigravity-debug.bat .

set AG_PATH=C:\Users\benji\AppData\Local\Programs\Antigravity\bin\antigravity.cmd
set DEBUG_PORT=9000

if "%~1"=="" (
    echo Opening current folder in Antigravity (Debug Mode)...
    start "" "%AG_PATH%" . --remote-debugging-port=%DEBUG_PORT%
) else (
    echo Opening "%~1" in Antigravity (Debug Mode)...
    start "" "%AG_PATH%" "%~1" --remote-debugging-port=%DEBUG_PORT%
)

echo.
echo Antigravity launched with --remote-debugging-port=%DEBUG_PORT%
echo AG Phone Connect can now detect this window.
