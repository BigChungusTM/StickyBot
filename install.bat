@echo off
echo Installing StickyBot dependencies...

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Node.js is not installed. Please install Node.js from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

:: Check if npm is installed
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo npm is not found. Please ensure Node.js is installed correctly.
    pause
    exit /b 1
)

:: Install dependencies
echo Installing npm packages...
call npm install

:: Create .env file if it doesn't exist
if not exist ".env" (
    echo Creating .env file from example...
    copy /Y .env.example .env >nul
    echo .env file created. Please edit it with your configuration.
) else (
    echo .env file already exists. Skipping creation.
)

echo.
echo Installation complete!
echo 1. Edit the .env file with your configuration
echo 2. Run start.bat to start the bot
echo.
pause
