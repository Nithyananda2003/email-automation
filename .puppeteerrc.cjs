const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Cache Chrome in the project folder so Render finds it after build
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
