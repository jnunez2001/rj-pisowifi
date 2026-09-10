@echo off
setlocal enabledelayedexpansion

REM ===== StarkFi Rental Client - Uninstaller =====
REM Reconstructed script (see README.md's note at the top) - not yet
REM re-verified on real hardware after reconstruction. Run as
REM Administrator (right-click > Run as administrator).

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo This uninstaller must be run as Administrator.
    echo Right-click uninstall.bat and choose "Run as administrator".
    pause
    exit /b 1
)

set "INSTALL_DIR=%ProgramFiles%\StarkFiRental"
set "DEST_EXE=%INSTALL_DIR%\StarkFiRentalClient.exe"
set "STARTUP_DIR=%ProgramData%\Microsoft\Windows\Start Menu\Programs\StartUp"
set "SHORTCUT=%STARTUP_DIR%\StarkFiRentalClient.lnk"

echo Removing startup shortcut ...
if exist "%SHORTCUT%" del /f /q "%SHORTCUT%"

echo Re-enabling Task Manager ...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /f >nul 2>&1

echo Checking for shell replacement ...
for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v Shell 2^>nul ^| findstr /i "Shell"') do set "CURRENT_SHELL=%%B"
if /i "!CURRENT_SHELL!"=="%DEST_EXE%" (
    echo Reverting shell back to explorer.exe ...
    reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v Shell /t REG_SZ /d "explorer.exe" /f >nul
) else (
    echo Shell is not currently pointed at this app - leaving it untouched.
)

echo Removing installed files ...
if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"

echo.
echo StarkFi Rental Client has been uninstalled.
echo.
pause
