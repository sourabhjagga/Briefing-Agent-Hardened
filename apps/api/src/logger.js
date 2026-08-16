const fs = require('fs');
const path = require('path');

const logFilePath = path.resolve(__dirname, '../logs/agent.log');

// Patterns to sanitize from logs — prevents WhatsApp Noise/Signal session key dumps
const SENSITIVE_PATTERNS = [
  /remoteJid['"]?\s*:\s*['"]?[^,}\s]+/gi,
  /noiseKey['"]?\s*:\s*\{[^}]*\}/gi,
  /signedIdentityKey['"]?\s*:\s*\{[^}]*\}/gi,
  /signedPreKey['"]?\s*:\s*\{[^}]*\}/gi,
  /registrationId['"]?\s*:\s*\d+/gi,
  /advSecretKey['"]?\s*:\s*['"]?[A-Za-z0-9+\/=]{20,}/gi,
  /private['"]?\s*:\s*\{\s*type['"]?\s*:\s*['"]?Buffer/gi,
  /"type"\s*:\s*"Buffer"\s*,\s*"data"\s*:\s*\[[\d,\s]+\]/gi,
];

function sanitize(msg) {
  if (typeof msg !== 'string') return msg;
  let out = msg;
  for (const pat of SENSITIVE_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  // Truncate very long single-line dumps (>2000 chars) — likely raw session objects
  if (out.length > 2000 && !out.includes('\n')) {
    out = out.substring(0, 200) + ' ... [TRUNCATED LONG LINE]';
  }
  return out;
}

function getTimestamp() {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).substring(0, 19);
}

const dir = path.dirname(logFilePath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeToFile(level, message) {
  const line = `[${getTimestamp()}] [${level}] ${message}\n`;
  fs.appendFileSync(logFilePath, line, 'utf8');
}

const logger = {
  info: (msg) => {
    const clean = sanitize(msg);
    const formatted = `\x1b[32m[INFO]\x1b[0m ${clean}`;
    console.log(`${getTimestamp()} ${formatted}`);
    writeToFile('INFO', clean);
  },
  warn: (msg) => {
    const clean = sanitize(msg);
    const formatted = `\x1b[33m[WARN]\x1b[0m ${clean}`;
    console.warn(`${getTimestamp()} ${formatted}`);
    writeToFile('WARN', clean);
  },
  error: (msg) => {
    const clean = sanitize(msg);
    const formatted = `\x1b[31m[ERROR]\x1b[0m ${clean}`;
    console.error(`${getTimestamp()} ${formatted}`);
    writeToFile('ERROR', clean);
  },
  debug: (msg) => {
    if (process.env.NODE_ENV !== 'production') {
      const clean = sanitize(msg);
      const formatted = `\x1b[36m[DEBUG]\x1b[0m ${clean}`;
      console.log(`${getTimestamp()} ${formatted}`);
      writeToFile('DEBUG', clean);
    }
  }
};

module.exports = logger;
