@echo off
setlocal enabledelayedexpansion

REM ===== StarkFi Rental Client - Installer =====
REM Reconstructed script (see README.md's note at the top) - not yet
REM re-verified on real hardware after reconstruction. Run as
REM Administrator (right-click > Run as administrator).

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo This installer must be run as Administrator.
    echo Right-click install.bat and choose "Run as administrator".
    pause
    exit /b 1
)

set "SRC_EXE=%~dp0StarkFiRentalClient.exe"
set "INSTALL_DIR=%ProgramFiles%\StarkFiRental"
set "DEST_EXE=%INSTALL_DIR%\StarkFiRentalClient.exe"
set "STARTUP_DIR=%ProgramData%\Microsoft\Windows\Start Menu\Programs\StartUp"
set "SHORTCUT=%STARTUP_DIR%\StarkFiRentalClient.lnk"

if not exist "%SRC_EXE%" (
    echo Could not find StarkFiRentalClient.exe next to this script.
    echo Publish it first: dotnet publish -c Release -r win-x64
    pause
    exit /b 1
)

echo Installing to %INSTALL_DIR% ...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%SRC_EXE%" "%DEST_EXE%" >nul

echo Adding startup shortcut for all users ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
    "$s.TargetPath = '%DEST_EXE%';" ^
    "$s.WorkingDirectory = '%INSTALL_DIR%';" ^
    "$s.Save()"

echo Disabling Task Manager ...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /t REG_DWORD /d 1 /f >nul

echo.
echo Done. StarkFi Rental Client will launch automatically at next login.
echo.
echo To make it survive Alt+F4 / a plain reboot (real kiosk lockdown),
echo see the "Making it survive Alt+F4" section in README.md - that
echo step is deliberately manual, not automated by this script.
echo.
pause
