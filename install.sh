#!/bin/bash

echo "🚀 Installing StickyBot dependencies..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js (v14 or later) and try again."
    echo "   Download: https://nodejs.org/"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please ensure Node.js is installed correctly."
    exit 1
fi

# Install dependencies
echo "📦 Installing npm packages..."
npm install

# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo "📄 Creating .env file from example..."
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "   Please edit the .env file with your configuration."
    else
        echo "⚠️  Warning: .env.example not found. Creating empty .env file."
        touch .env
    fi
else
    echo "ℹ️  .env file already exists. Skipping creation."
fi

# Make start script executable
chmod +x start.sh

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Edit the .env file with your configuration"
echo "   $ nano .env"
echo "2. Start the bot with:"
echo "   $ ./start.sh"
