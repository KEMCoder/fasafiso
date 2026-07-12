const express = require('express');
const axios = require('axios');
const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json()); // Support parsing JSON body for remote logging

const PORT = process.env.PORT || 3000;
const TABII_ORIGIN = 'https://www.tabii.com';
const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2661.102 Safari/537.36';

const CACHE_DIR = path.join(__dirname, '.cache');
const POLYFILLS_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
if (!fs.existsSync(POLYFILLS_DIR)) fs.mkdirSync(POLYFILLS_DIR);

// URLs for robust polyfills
const POLYFILL_URLS = {
  coreJs: 'https://cdnjs.cloudflare.com/ajax/libs/core-js/3.37.1/minified.js',
  fetch: 'https://cdnjs.cloudflare.com/ajax/libs/fetch/3.6.20/fetch.min.js',
  urlSearchParams: 'https://cdnjs.cloudflare.com/ajax/libs/url-search-params/1.1.0/url-search-params.js'
};

// Download polyfills if they don't exist locally
async function downloadPolyfills() {
  for (const [key, url] of Object.entries(POLYFILL_URLS)) {
    const filePath = path.join(POLYFILLS_DIR, `${key}.js`);
    if (!fs.existsSync(filePath)) {
      console.log(`Downloading polyfill: ${key} from ${url}...`);
      try {
        const response = await axios.get(url, { headers: { 'User-Agent': PC_USER_AGENT } });
        fs.writeFileSync(filePath, response.data);
        console.log(`Saved ${key}.js`);
      } catch (err) {
        console.error(`Failed to download polyfill ${key}:`, err.message);
      }
    }
  }
}

// Receive remote logs from the TV browser and print them in the PC terminal
app.post('/_proxy/log', (req, res) => {
  const { type, message } = req.body;
  let prefix = '[TV LOG]';
  if (type === 'error' || type === 'window-error') {
    prefix = '\x1b[31m[TV ERROR]\x1b[0m'; // Red
  } else if (type === 'warn') {
    prefix = '\x1b[33m[TV WARN]\x1b[0m';  // Yellow
  } else {
    prefix = '\x1b[36m[TV LOG]\x1b[0m';   // Cyan
  }
  console.log(`${prefix} ${message}`);
  res.sendStatus(200);
});

// Serve downloaded polyfills and inject remote logger
app.get('/_proxy/polyfills.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  let combined = '';
  
  // Inject remote logging code FIRST so that all errors from other polyfills/scripts are captured
  combined += `
    (function() {
      var proxyLogUrl = '/_proxy/log';
      function sendLog(type, args) {
        var msg = Array.prototype.slice.call(args).map(function(arg) {
          if (arg === null) return 'null';
          if (arg === undefined) return 'undefined';
          if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch(e) { return arg.toString(); }
          }
          return String(arg);
        }).join(' ');
        
        var xhr = new XMLHttpRequest();
        xhr.open('POST', proxyLogUrl, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ type: type, message: msg }));
      }

      // Hijack console methods
      var originalLog = console.log;
      console.log = function() {
        sendLog('log', arguments);
        if (originalLog) originalLog.apply(console, arguments);
      };
      
      var originalError = console.error;
      console.error = function() {
        sendLog('error', arguments);
        if (originalError) originalError.apply(console, arguments);
      };
      
      var originalWarn = console.warn;
      console.warn = function() {
        sendLog('warn', arguments);
        if (originalWarn) originalWarn.apply(console, arguments);
      };

      // Catch unhandled errors
      window.addEventListener('error', function(e) {
        var msg = e.message + ' at ' + e.filename + ':' + e.lineno + ':' + e.colno;
        if (e.error && e.error.stack) {
          msg += '\\nStack: ' + e.error.stack;
        }
        sendLog('window-error', [msg]);
      });
      
      console.log("Remote logging initialized. TV is streaming console logs to PC.");
    })();
  `;

  try {
    if (fs.existsSync(path.join(POLYFILLS_DIR, 'coreJs.js'))) {
      combined += fs.readFileSync(path.join(POLYFILLS_DIR, 'coreJs.js'), 'utf8') + '\n';
    }
    if (fs.existsSync(path.join(POLYFILLS_DIR, 'fetch.js'))) {
      combined += fs.readFileSync(path.join(POLYFILLS_DIR, 'fetch.js'), 'utf8') + '\n';
    }
    if (fs.existsSync(path.join(POLYFILLS_DIR, 'urlSearchParams.js'))) {
      combined += fs.readFileSync(path.join(POLYFILLS_DIR, 'urlSearchParams.js'), 'utf8') + '\n';
    }
    
    // Strip ES6 export statements to prevent SyntaxError in browsers that don't support ES modules
    combined = combined.replace(/\bexport\s*\{[^}]+\};?/g, '');
    combined = combined.replace(/\bexport\s+default\s+[\w\d_]+;?/g, '');
    
    // Inject custom fixes for webOS 2.2.0 compatibility
    combined += `
      (function() {
        window.exports = window.exports || {};
        window.module = window.module || { exports: window.exports };
        window.requestAnimationFrame = window.requestAnimationFrame || window.webkitRequestAnimationFrame || function(cb) { setTimeout(cb, 16); };
      })();
    `;
    
    res.send(combined);
  } catch (err) {
    res.status(500).send(`console.error("Failed to load polyfills on proxy: " + ${JSON.stringify(err.message)});`);
  }
});

// Main proxy route
app.all('*', async (req, res) => {
  // Exclude proxy helper routes
  if (req.path === '/_proxy/polyfills.js' || req.path === '/_proxy/log') return;

  const targetUrl = TABII_ORIGIN + req.url;
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  
  // Setup headers for tabii.com
  const headers = { ...req.headers };
  headers['host'] = 'www.tabii.com';
  headers['user-agent'] = PC_USER_AGENT;
  
  // Adjust referer and origin to tabii.com to avoid CORS/security blocks
  if (headers['referer']) {
    headers['referer'] = headers['referer'].replace(req.headers.host, 'www.tabii.com');
  }
  if (headers['origin']) {
    headers['origin'] = headers['origin'].replace(req.headers.host, 'https://www.tabii.com');
  }

  const requestConfig = {
    method: req.method,
    url: targetUrl,
    headers: headers,
    responseType: 'arraybuffer',
    validateStatus: () => true
  };

  try {
    const response = await axios(requestConfig);
    
    // Forward response status and headers
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, val]) => {
      if (key.toLowerCase() !== 'content-length' && 
          key.toLowerCase() !== 'content-security-policy' && 
          key.toLowerCase() !== 'x-frame-options') {
        res.setHeader(key, val);
      }
    });

    const contentType = response.headers['content-type'] || '';
    
    // 1. Handle JS files: Transpilation to ES5
    if (req.path.endsWith('.js') || contentType.includes('javascript')) {
      const originalJs = response.data.toString('utf8');
      const cacheKey = path.basename(req.path) + '_' + require('crypto').createHash('md5').update(originalJs).digest('hex') + '.js';
      const cachePath = path.join(CACHE_DIR, cacheKey);

      if (fs.existsSync(cachePath)) {
        const cachedJs = fs.readFileSync(cachePath, 'utf8');
        res.setHeader('Content-Type', 'application/javascript');
        return res.send(cachedJs);
      }

      console.log(`Transpiling JS chunk: ${req.path}...`);
      try {
        const transpiled = babel.transformSync(originalJs, {
          presets: [
            ['@babel/preset-env', {
              targets: {
                chrome: '38'
              },
              useBuiltIns: false,
              modules: 'auto' // Transpile ES modules to CommonJS
            }]
          ],
          compact: true,
          minified: true
        });

        fs.writeFileSync(cachePath, transpiled.code);
        res.setHeader('Content-Type', 'application/javascript');
        return res.send(transpiled.code);
      } catch (babelErr) {
        console.error(`Babel transpilation failed for ${req.path}:`, babelErr.message);
        res.setHeader('Content-Type', 'application/javascript');
        return res.send(originalJs);
      }
    }

    // 2. Handle HTML files: Inject polyfills
    if (contentType.includes('html')) {
      let html = response.data.toString('utf8');
      
      const polyfillScript = '<script src="/_proxy/polyfills.js"></script>';
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${polyfillScript}`);
      } else {
        html = polyfillScript + html;
      }
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    // 3. Handle other files (images, fonts, API json, video segments)
    return res.send(response.data);

  } catch (err) {
    console.error(`Proxy request failed to ${targetUrl}:`, err.message);
    res.status(500).send(`Proxy Error: ${err.message}`);
  }
});

// Start server after downloading polyfills
downloadPolyfills().then(() => {
  app.listen(PORT, () => {
    console.log(`tabii webOS Proxy Server is running at http://localhost:${PORT}`);
    console.log(`Target: ${TABII_ORIGIN}`);
    console.log(`Target User-Agent (Spoofed): ${PC_USER_AGENT}`);
  });
});
