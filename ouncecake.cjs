#!/usr/bin/env node
// Compatibility entry point for existing commands and scripts.
const yoink = require('./yoink.cjs');

if (require.main === module) {
  yoink.main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = yoink;
