@echo off
setlocal enabledelayedexpansion
n:: Set color variables
for /F "tokens=1,2 delims=#" %%a in ('"prompt #$H#$E# & echo on & for %%b in (1) do rem"') do (set "DEL=%%a")
set "RED=!DEL! [91m"
set "GREEN=!DEL! [92m"
set "YELLOW=!DEL! [93m"
set "NC=!DEL! [0m"

echo %GREEN%🚀 Installing StickyBot dependencies...%NC%

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo %RED%❌ Node.js is not installed. Please install Node.js (v14 or later) and try again.%NC%
    echo    Download: https://nodejs.org/
    pause
    exit /b 1
)

:: Check Node.js version
for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
set NODE_VERSION=!NODE_VERSION:~1!
for /f "tokens=1 delims=." %%a in ("!NODE_VERSION!") do set MAJOR_VERSION=%%a

if !MAJOR_VERSION! LSS 14 (
    echo %RED%❌ Node.js version !NODE_VERSION! is not supported. Please install Node.js v14 or later.%NC%
    pause
    exit /b 1
)

:: Check if npm is installed
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo %RED%❌ npm is not found. Please ensure Node.js is installed correctly.%NC%
    pause
    exit /b 1
)

:: Create .env file if it doesn't exist
if not exist ".env" (
    echo %YELLOW%📄 Creating .env file from example...%NC%
    if exist ".env.example" (
        copy /Y .env.example .env >nul
        echo    %YELLOW%Please edit the .env file with your configuration.%NC%
        echo    %YELLOW%Required variables:%NC%
        echo    - COINBASE_API_KEY
        echo    - COINBASE_API_SECRET
        echo    - TELEGRAM_BOT_TOKEN (optional, for notifications)
        echo    - TELEGRAM_CHAT_ID (optional, for notifications)
    ) else (
        echo %YELLOW%⚠️  Warning: .env.example not found. Creating empty .env file.%NC%
        echo. > .env
    )
) else (
    echo %GREEN%ℹ️  .env file already exists. Skipping creation.%NC%
)

:: Install dependencies
echo.
echo %GREEN%📦 Installing npm packages...%NC%
call npm install
if %ERRORLEVEL% neq 0 (
    echo %RED%❌ Failed to install npm packages. Please check the error above.%NC%
    pause
    exit /b 1
)

echo.
echo %GREEN%✅ Installation complete!%NC%
echo.
echo %GREEN%Next steps:%NC%
echo 1. Edit the .env file with your configuration:
echo    notepad .env
echo 2. Start the bot with:
echo    node syrupBot.js
echo    Or if you have a start script:
echo    start.bat
echo.
echo %YELLOW%Note: Make sure to set up the required environment variables before starting the bot.%NC%
echo.
pause
