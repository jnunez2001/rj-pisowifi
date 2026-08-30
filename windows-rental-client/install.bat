@echo off
setlocal enabledelayedexpansion

rem StarkFi Rental Client installer.
rem Run this from the same folder as StarkFiRentalClient.exe (the
rem published single-file exe - see README.md's "Publishing" section).
rem Right-click this file and "Run as administrator" - the Task Manager
rem lock and the startup shortcut both need admin rights.

set INSTALL_DIR=%ProgramFiles%\StarkFiRental
set EXE_NAME=StarkFiRentalClient.exe
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

if not exist "%~dp0%EXE_NAME%" (
    echo Could not find %EXE_NAME% next to this script.
    echo Publish it first with: dotnet publish -c Release -r win-x64
    pause
    exit /b 1
)

echo Installing to %INSTALL_DIR% ...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%~dp0%EXE_NAME%" "%INSTALL_DIR%\%EXE_NAME%" >nul

echo Creating startup shortcut ...
powershell -NoProfile -Command ^
    "$s = (New-Object -COM WScript.Shell).CreateShortcut('%STARTUP_DIR%\StarkFiRentalClient.lnk'); $s.TargetPath = '%INSTALL_DIR%\%EXE_NAME%'; $s.Save()"

echo Locking Task Manager ...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /t REG_DWORD /d 1 /f >nul

echo.
echo Done. StarkFiRentalClient will start automatically at next login.
echo To run it right now: "%INSTALL_DIR%\%EXE_NAME%"
echo.
echo This did NOT set up shell replacement (the step that makes the app
echo unclosable via Alt+F4/reboot) - that's still a separate, deliberate
echo step, see README.md.
echo.
pause
