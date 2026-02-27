@echo off
:: Installs "Open with Antigravity (Debug)" to the Windows right-click context menu
:: Run this script AS ADMINISTRATOR once.
:: After installation, right-clicking any folder will show the option.

echo ===================================================
echo   Antigravity Debug Mode - Context Menu Installer
echo ===================================================
echo.

set AG_CMD=C:\Users\benji\AppData\Local\Programs\Antigravity\bin\antigravity.cmd
set AG_ICON=C:\Users\benji\AppData\Local\Programs\Antigravity\Antigravity.exe

:: Add to folder right-click context menu
reg add "HKCU\Software\Classes\Directory\shell\AntigravityDebug" /ve /d "Open with Antigravity (Debug)" /f
reg add "HKCU\Software\Classes\Directory\shell\AntigravityDebug" /v "Icon" /d "%AG_ICON%" /f
reg add "HKCU\Software\Classes\Directory\shell\AntigravityDebug\command" /ve /d "\"%AG_CMD%\" \"%%V\" --remote-debugging-port=9000" /f

:: Add to folder background (right-click inside a folder)
reg add "HKCU\Software\Classes\Directory\Background\shell\AntigravityDebug" /ve /d "Open with Antigravity (Debug)" /f
reg add "HKCU\Software\Classes\Directory\Background\shell\AntigravityDebug" /v "Icon" /d "%AG_ICON%" /f
reg add "HKCU\Software\Classes\Directory\Background\shell\AntigravityDebug\command" /ve /d "\"%AG_CMD%\" \"%%V\" --remote-debugging-port=9000" /f

echo.
echo Done! You can now right-click any folder and select
echo "Open with Antigravity (Debug)" to launch with Phone Connect support.
echo.
pause
