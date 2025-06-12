@echo off
echo Starting StickyBot...

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Node.js is not installed. Please install Node.js from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

:: Check if .env exists
if not exist ".env" (
    echo .env file not found. Please run install.bat first.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo Dependencies not installed. Running install.bat...
    call install.bat
)

:: Start the bot
echo Starting StickyBot...
node syrupBot.js

:: If the bot crashes or stops
if %ERRORLEVEL% neq 0 (
    echo.
    echo Bot stopped with an error. Press any key to exit.
    pause >nul
    exit /b 1
)

echo.
echo Bot stopped. Press any key to exit.
pause >nul
