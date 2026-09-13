@echo off
setlocal enabledelayedexpansion

title Mellow Server
cd /d "%~dp0"

echo ========================================================
echo               Mellow Server Launcher                    
echo ========================================================
echo.

:: Check for Node.js
where node >nul 2>&1
if errorlevel 1 goto :node_missing
goto :check_version

:node_missing
echo [WARNING] Node.js is not installed or not found in PATH!
echo.
where winget >nul 2>&1
if errorlevel 1 goto :no_winget

echo Windows Package Manager (winget) was detected.
set /p "INSTALL_NODE=Would you like to automatically download and install Node.js LTS now? (Y/N): "
if /i "!INSTALL_NODE!"=="Y" (
    echo.
    echo [INFO] Downloading and installing Node.js LTS via winget...
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    echo.
    echo [NOTE] Please restart your terminal/command prompt and run start.bat again
    echo        so the new PATH environment variables take effect.
    pause
    exit /b 0
)

:no_winget
echo Please download and install Node.js 22.5.0 or higher from:
echo   https://nodejs.org/
echo.
pause
exit /b 1

:check_version
:: Check Node.js version (v22.5.0+ recommended for node:sqlite)
node -e "const [maj, min] = process.versions.node.split('.').map(Number); if (maj < 22 || (maj === 22 && min < 5)) process.exit(1);" >nul 2>&1
if not errorlevel 1 goto :check_deps

for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
echo [WARNING] Current Node.js version is !NODE_VER!.
echo Mellow requires Node.js v22.5.0+ for native SQLite (node:sqlite).
echo If you experience database errors, please upgrade Node.js.
echo.

:check_deps
:: Check if --install or -i flag was passed
set "FORCE_INSTALL=0"
if "%~1"=="--install" set "FORCE_INSTALL=1"
if "%~1"=="-i" set "FORCE_INSTALL=1"

:: Check if dependencies are missing or incomplete
if not exist "node_modules\" set "FORCE_INSTALL=1"
if not exist "node_modules\express\" set "FORCE_INSTALL=1"
if not exist "node_modules\ws\" set "FORCE_INSTALL=1"
if not exist "node_modules\multer\" set "FORCE_INSTALL=1"
if not exist "node_modules\selfsigned\" set "FORCE_INSTALL=1"
if not exist "node_modules\emoji-picker-element\" set "FORCE_INSTALL=1"

if "!FORCE_INSTALL!"=="1" (
    echo [INFO] Dependencies missing or incomplete.
    echo [INFO] Auto-downloading and installing dependencies via npm...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install encountered an error!
        pause
        exit /b 1
    )
    echo [SUCCESS] Dependencies downloaded and installed successfully.
    echo.
)

echo [INFO] Starting Mellow Server...
echo.
call npm start

if errorlevel 1 (
    echo.
    echo [ERROR] Server exited with code %errorlevel%.
    pause
)
