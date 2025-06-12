#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('Setting up your .env file...');
console.log('Please enter the following configuration values:');

const questions = [
  { name: 'COINBASE_API_KEY_ID', description: 'Coinbase API Key ID' },
  { name: 'COINBASE_API_SECRET', description: 'Coinbase API Secret' },
  { name: 'COINBASE_API_NICKNAME', description: 'Coinbase API Nickname', default: 'tradjo' },
  { name: 'PORTFOLIO_NAME', description: 'Portfolio Name', default: 'Tradjo' },
  { name: 'MAKER_FEE', description: 'Maker Fee (%)', default: '0.6' },
  { name: 'TAKER_FEE', description: 'Taker Fee (%)', default: '1.2' },
  { name: 'PROFIT_THRESHOLD', description: 'Profit Threshold (%)', default: '2.0' },
  { name: 'POST_ONLY_SELLS', description: 'Use Post-Only Sells (true/false)', default: 'true' },
  { name: 'LOG_LEVEL', description: 'Log Level (error/warn/info/debug)', default: 'info' },
  { name: 'LOG_TO_FILE', description: 'Log to File (true/false)', default: 'true' },
  { name: 'LOG_FILE_PATH', description: 'Log File Path', default: 'logs/syrup-bot.log' }
];

const envVars = {};

function askQuestion(index) {
  if (index >= questions.length) {
    // All questions answered, write to .env file
    const envContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    
    fs.writeFileSync('.env', envContent);
    console.log('\n✅ .env file created successfully!');
    console.log('⚠️  Remember to never commit this file to version control.');
    process.exit(0);
  }

  const q = questions[index];
  const prompt = `\n${q.description}${q.default ? ` [${q.default}]` : ''}: `;
  
  readline.question(prompt, (answer) => {
    const value = answer.trim() || q.default || '';
    if (value) {
      envVars[q.name] = value;
    }
    askQuestion(index + 1);
  });
}

// Start asking questions
askQuestion(0);
