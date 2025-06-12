#!/bin/bash

# Set error handling
set -e

echo "🚀 Starting StickyBot..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js (v14 or later) and try again."
    echo "   Download: https://nodejs.org/"
    exit 1
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found. Please run ./install.sh first."
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "⚠️  Dependencies not installed. Running install.sh..."
    ./install.sh
fi

# Start the bot
echo "🚀 Launching StickyBot..."
node syrupBot.js

# Check if the bot crashed
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Bot stopped with an error."
    exit 1
fi

echo ""
echo "👋 Bot stopped."
