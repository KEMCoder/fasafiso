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
      var originalLog = console.log;
      console.log = function() { sendLog('log', arguments); if (originalLog) originalLog.apply(console, arguments); };
      var originalError = console.error;
      console.error = function() { sendLog('error', arguments); if (originalError) originalError.apply(console, arguments); };
      var originalWarn = console.warn;
      console.warn = function() { sendLog('warn', arguments); if (originalWarn) originalWarn.apply(console, arguments); };
      window.addEventListener('error', function(e) {
        var msg = e.message + ' at ' + e.filename + ':' + e.lineno + ':' + e.colno;
        sendLog('window-error', [JSON.stringify({line:e.lineno,column:e.colno,sourceURL:e.filename})]);
      });
      console.log("Remote logging initialized. TV is streaming console logs to PC.");
    })();
  `;

  // Inline minimal polyfills (NO CDN, NO export statements - 100% ES5 safe)
  combined += `
    (function(win) {
      // _N_E is Next.js global chunk registry - must exist before any chunk loads
      win._N_E = win._N_E || {};

      // Promise polyfill (tiny, ES5-only)
      if (!win.Promise) {
        win.Promise = (function() {
          function Promise(fn) {
            var state = 'pending', value, handlers = [];
            function resolve(val) {
              if (state !== 'pending') return;
              state = 'resolved'; value = val;
              handlers.forEach(function(h) { h.onFulfilled(val); });
            }
            function reject(val) {
              if (state !== 'pending') return;
              state = 'rejected'; value = val;
              handlers.forEach(function(h) { h.onRejected(val); });
            }
            function handle(h) {
              if (state === 'pending') { handlers.push(h); return; }
              if (state === 'resolved') { h.onFulfilled(value); return; }
              h.onRejected(value);
            }
            this.then = function(onFulfilled, onRejected) {
              return new Promise(function(resolve, reject) {
                handle({
                  onFulfilled: function(v) { try { resolve(onFulfilled ? onFulfilled(v) : v); } catch(e) { reject(e); } },
                  onRejected:  function(v) { try { resolve(onRejected ? onRejected(v) : v); } catch(e) { reject(e); } }
                });
              });
            };
            this.catch = function(onRejected) { return this.then(null, onRejected); };
            try { fn(resolve, reject); } catch(e) { reject(e); }
          }
          Promise.resolve = function(v) { return new Promise(function(res) { res(v); }); };
          Promise.reject = function(v) { return new Promise(function(res, rej) { rej(v); }); };
          Promise.all = function(arr) {
            return new Promise(function(res, rej) {
              var results = [], remaining = arr.length;
              if (!remaining) { res(results); return; }
              arr.forEach(function(p, i) {
                Promise.resolve(p).then(function(v) { results[i] = v; if (!--remaining) res(results); }, rej);
              });
            });
          };
          return Promise;
        })();
      }

      // Object.assign polyfill
      if (!Object.assign) {
        Object.assign = function(target) {
          for (var i = 1; i < arguments.length; i++) {
            var src = arguments[i];
            if (src) for (var key in src) { if (Object.prototype.hasOwnProperty.call(src, key)) target[key] = src[key]; }
          }
          return target;
        };
      }

      // Array.from polyfill
      if (!Array.from) {
        Array.from = function(obj) {
          return Array.prototype.slice.call(obj);
        };
      }

      // fetch polyfill using XMLHttpRequest
      if (!win.fetch) {
        win.fetch = function(url, opts) {
          opts = opts || {};
          return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(opts.method || 'GET', url);
            if (opts.headers) {
              Object.keys(opts.headers).forEach(function(k) { xhr.setRequestHeader(k, opts.headers[k]); });
            }
            xhr.onload = function() {
              var res = {
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                statusText: xhr.statusText,
                text: function() { return Promise.resolve(xhr.responseText); },
                json: function() { return Promise.resolve(JSON.parse(xhr.responseText)); }
              };
              resolve(res);
            };
            xhr.onerror = function() { reject(new Error('Network request failed')); };
            xhr.send(opts.body || null);
          });
        };
      }

      // requestAnimationFrame polyfill
      win.requestAnimationFrame = win.requestAnimationFrame || win.webkitRequestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
      win.cancelAnimationFrame = win.cancelAnimationFrame || function(id) { clearTimeout(id); };

      // URLSearchParams polyfill (minimal)
      if (!win.URLSearchParams) {
        win.URLSearchParams = function(str) {
          this._data = {};
          var self = this;
          if (str) {
            str.replace(/^\\?/, '').split('&').forEach(function(pair) {
              var parts = pair.split('=');
              if (parts[0]) self._data[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
            });
          }
          this.get = function(k) { return this._data[k] !== undefined ? this._data[k] : null; };
          this.set = function(k, v) { this._data[k] = v; };
          this.toString = function() {
            return Object.keys(this._data).map(function(k) {
              return encodeURIComponent(k) + '=' + encodeURIComponent(self._data[k]);
            }).join('&');
          };
        };
      }

      // window.exports and module safety
      win.exports = win.exports || {};
      win.module = win.module || { exports: win.exports };

      console.log("webOS polyfills loaded. _N_E=" + typeof win._N_E + " Promise=" + typeof win.Promise + " fetch=" + typeof win.fetch);
    })(window);
  `;

  res.send(combined);
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
    
    // 1. Handle JS files: Transpilation to ES5 (needed to compile modern JS features like const/let in webpack/framework chunks to ES5)
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
              modules: false // CRITICAL: Do not transpile ES modules, keep webpack/global scoping intact!
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

    // 2. Handle HTML files: Inject polyfills and strip trackers
    if (contentType.includes('html')) {
      let html = response.data.toString('utf8');
      
      // Strip AppsFlyer / Adjust tracking script content inside __NEXT_DATA__ JSON to prevent SyntaxError
      html = html.replace(/!function\(t,r,e,a,n,o,i,l,c,s,d,h,u\)[\s\S]*?__realObj[\s\S]*?\)\)/g, 'console.log("Tracker disabled")');
      
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
