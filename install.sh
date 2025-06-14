#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

echo -e "${GREEN}🚀 Installing StickyBot dependencies...${NC}"

# Check if Node.js is installed
if ! command_exists node; then
    echo -e "${RED}❌ Node.js is not installed. Please install Node.js (v14 or later) and try again.${NC}"
    echo "   Download: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2)
MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1)

if [ "$MAJOR_VERSION" -lt 14 ]; then
    echo -e "${RED}❌ Node.js version $NODE_VERSION is not supported. Please install Node.js v14 or later.${NC}"
    exit 1
fi

# Check if npm is installed
if ! command_exists npm; then
    echo -e "${RED}❌ npm is not installed. Please ensure Node.js is installed correctly.${NC}"
    exit 1
fi

# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}📄 Creating .env file from example...${NC}"
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "   ${YELLOW}Please edit the .env file with your configuration.${NC}"
        echo -e "   ${YELLOW}Required variables:${NC}"
        echo -e "   - COINBASE_API_KEY"
        echo -e "   - COINBASE_API_SECRET"
        echo -e "   - TELEGRAM_BOT_TOKEN (optional, for notifications)"
        echo -e "   - TELEGRAM_CHAT_ID (optional, for notifications)"
    else
        echo -e "${YELLOW}⚠️  Warning: .env.example not found. Creating empty .env file.${NC}"
        touch .env
    fi
else
    echo -e "${GREEN}ℹ️  .env file already exists. Skipping creation.${NC}"
fi

# Install dependencies
echo -e "\n${GREEN}📦 Installing npm packages...${NC}"
if ! npm install; then
    echo -e "${RED}❌ Failed to install npm packages. Please check the error above.${NC}"
    exit 1
fi

# Make start script executable if it exists
if [ -f "start.sh" ]; then
    chmod +x start.sh
fi

echo -e "\n${GREEN}✅ Installation complete!${NC}"
echo ""
echo -e "${GREEN}Next steps:${NC}"
echo "1. Edit the .env file with your configuration:"
echo "   $ nano .env"
echo "2. Start the bot with:"
echo "   $ node syrupBot.js"
echo "   Or if you have a start script:"
echo "   $ ./start.sh"
echo ""
echo -e "${YELLOW}Note: Make sure to set up the required environment variables before starting the bot.${NC}"
