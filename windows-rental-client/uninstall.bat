@echo off
setlocal enabledelayedexpansion

rem Reverses everything install.bat did. Run as administrator.

set EXE_NAME=StarkFiRentalClient.exe
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set MARKER_FILE=%ProgramData%\StarkFiRental\install_path.txt

rem install.bat lets the install folder be chosen at setup time and
rem writes it to MARKER_FILE - read it back here instead of assuming the
rem default Program Files path, so uninstall works no matter where it
rem was actually installed. Falls back to the old default for installs
rem done before this marker file existed.
set INSTALL_DIR=%ProgramFiles%\StarkFiRental
if exist "%MARKER_FILE%" (
    for /f "usebackq delims=" %%A in ("%MARKER_FILE%") do set INSTALL_DIR=%%A
)

echo Removing startup shortcut ...
del /Q "%STARTUP_DIR%\StarkFiRentalClient.lnk" 2>nul

echo Re-enabling Task Manager ...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /f >nul 2>&1

rem Only revert shell replacement if it's still pointed at THIS app - if
rem an operator changed Shell to something else since, this must not
rem clobber that. Checks the current value first, only writes back
rem explorer.exe when it still matches this app's own install path.
for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v Shell 2^>nul ^| findstr /I "REG_SZ"') do set CURRENT_SHELL=%%B
echo %CURRENT_SHELL% | findstr /I /C:"%EXE_NAME%" >nul
if %ERRORLEVEL%==0 (
    echo Reverting shell replacement back to explorer.exe ...
    reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v Shell /t REG_SZ /d "explorer.exe" /f >nul
)

echo Removing installed files from "%INSTALL_DIR%" ...
if exist "%INSTALL_DIR%" rmdir /S /Q "%INSTALL_DIR%"

echo Removing install marker ...
del /Q "%MARKER_FILE%" 2>nul

echo.
echo Uninstall complete. A reboot is recommended if shell replacement was reverted.
echo.
pause
