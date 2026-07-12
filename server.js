const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const TABII_ORIGIN = 'https://www.tabii.com';
const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Global Session Stores for TV Pairing
const activeSessions = {}; // session_id -> { accessToken, refreshToken, timestamp }
const pendingActivations = {}; // 6-digit-code -> { status, accessToken, refreshToken, timestamp }

// Dynamic buildId parsing
let currentBuildId = '10.07.2026-07.44.16';
async function updateBuildId() {
  try {
    const response = await axios.get('https://www.tabii.com/tr', { headers: { 'User-Agent': PC_USER_AGENT } });
    const html = response.data;
    const match = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (match && match[1]) {
      currentBuildId = match[1];
      console.log('[BUILD ID] Updated tabii buildId to:', currentBuildId);
    }
  } catch (err) {
    console.error('[BUILD ID] Failed to update buildId, using fallback:', currentBuildId, err.message);
  }
}

// Update buildId on startup and then every 30 minutes
updateBuildId();
setInterval(updateBuildId, 30 * 60 * 1000);

// Helper function to parse cookie manually
function getCookie(req, name) {
  const rc = req.headers.cookie;
  if (!rc) return null;
  const cookies = rc.split(';').reduce((acc, c) => {
    const parts = c.split('=');
    acc[parts.shift().trim()] = decodeURI(parts.join('='));
    return acc;
  }, {});
  return cookies[name] || null;
}

// Receive remote logs from TV and output in console
app.post('/_proxy/log', (req, res) => {
  const { type, message } = req.body;
  let prefix = '[TV LOG]';
  if (type === 'error' || type === 'window-error') {
    prefix = '\x1b[31m[TV ERROR]\x1b[0m';
  } else if (type === 'warn') {
    prefix = '\x1b[33m[TV WARN]\x1b[0m';
  } else {
    prefix = '\x1b[36m[TV LOG]\x1b[0m';
  }
  console.log(`${prefix} ${message}`);
  res.sendStatus(200);
});

// Minimal, 100% ES5-safe polyfills for older smart TVs (webOS 2.2.0)
app.get('/_proxy/polyfills.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  let combined = `
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
        sendLog('window-error', [JSON.stringify({line:e.lineno,column:e.colno,sourceURL:e.filename,message:e.message})]);
      });
      console.log("Remote logging initialized on TV.");
    })();

    (function(win) {
      win._N_E = win._N_E || {};

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

      if (!Object.assign) {
        Object.assign = function(target) {
          for (var i = 1; i < arguments.length; i++) {
            var src = arguments[i];
            if (src) for (var key in src) { if (Object.prototype.hasOwnProperty.call(src, key)) target[key] = src[key]; }
          }
          return target;
        };
      }

      if (!Array.from) {
        Array.from = function(obj) { return Array.prototype.slice.call(obj); };
      }

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

      win.requestAnimationFrame = win.requestAnimationFrame || win.webkitRequestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
      win.cancelAnimationFrame = win.cancelAnimationFrame || function(id) { clearTimeout(id); };

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

      win.exports = win.exports || {};
      win.module = win.module || { exports: win.exports };
      console.log("ES5 core polyfills loaded successfully.");
    })(window);
  `;
  res.send(combined);
});

// Image Proxy to avoid CORS/SSL issues on older TVs
app.get('/_proxy/image/:name', async (req, res) => {
  const imageUrl = `https://cms-tabii-public-image.tabii.com/int/${req.params.name}`;
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'stream',
      headers: { 'User-Agent': PC_USER_AGENT }
    });
    res.setHeader('Content-Type', response.headers['content-type']);
    response.data.pipe(res);
  } catch (err) {
    res.sendStatus(404);
  }
});

// pairing endpoints
app.get('/_proxy/get-code', (req, res) => {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (pendingActivations[code]);

  pendingActivations[code] = {
    status: 'pending',
    timestamp: Date.now()
  };

  console.log(`[PAIRING] Generated pairing code ${code} for TV`);
  res.json({ code: code });
});

app.get('/_proxy/poll-session', (req, res) => {
  const code = req.query.code;
  if (!code || !pendingActivations[code]) {
    return res.json({ status: 'error', message: 'Invalid code' });
  }

  const activation = pendingActivations[code];
  if (Date.now() - activation.timestamp > 10 * 60 * 1000) { // 10 min expiry
    delete pendingActivations[code];
    return res.json({ status: 'expired' });
  }

  if (activation.status === 'activated') {
    console.log(`[PAIRING] TV paired successfully using code ${code}`);
    res.json({
      status: 'success',
      tokens: {
        accessToken: activation.accessToken,
        refreshToken: activation.refreshToken
      }
    });
    delete pendingActivations[code];
  } else {
    res.json({ status: 'pending' });
  }
});

// Device Activation HTML interface
app.get('/activate', (req, res) => {
  const sessionId = getCookie(req, 'proxy_session_id');
  const session = sessionId ? activeSessions[sessionId] : null;

  if (!session) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>tabii TV - Cihaz Eşleştirme</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <style>
          body { background-color: #0b0f19; color: #ffffff; font-family: 'Outfit', sans-serif; margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
          .card { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.05); padding: 40px; border-radius: 20px; text-align: center; max-width: 400px; width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
          h1 { color: #00ffcc; margin-top: 0; }
          p { color: #8a99ad; line-height: 1.6; }
          .btn { background: linear-gradient(135deg, #00ffcc, #00b3ff); color: #0b0f19; border: none; padding: 15px 30px; font-size: 16px; font-weight: bold; border-radius: 10px; cursor: pointer; width: 100%; margin-top: 20px; transition: transform 0.2s; text-decoration: none; display: block; }
          .btn:hover { transform: scale(1.02); }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>tabii TV</h1>
          <p>Cihazınızı eşleştirmek için öncelikle tabii hesabınızla giriş yapmalısınız.</p>
          <a class="btn" href="/tr/login">Giriş Yap</a>
        </div>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>tabii TV - Cihaz Eşleştirme</title>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
      <style>
        body { background-color: #0b0f19; color: #ffffff; font-family: 'Outfit', sans-serif; margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
        .card { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.05); padding: 40px; border-radius: 20px; text-align: center; max-width: 400px; width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h1 { color: #00ffcc; margin-top: 0; }
        p { color: #8a99ad; line-height: 1.6; }
        .input-code { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #ffffff; padding: 15px; font-size: 24px; text-align: center; letter-spacing: 5px; border-radius: 10px; width: 80%; margin-top: 20px; outline: none; }
        .input-code:focus { border-color: #00ffcc; }
        .btn { background: linear-gradient(135deg, #00ffcc, #00b3ff); color: #0b0f19; border: none; padding: 15px 30px; font-size: 16px; font-weight: bold; border-radius: 10px; cursor: pointer; width: 100%; margin-top: 20px; transition: transform 0.2s; }
        .btn:hover { transform: scale(1.02); }
        .error { color: #ff3366; margin-top: 10px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Cihazı Eşleştir</h1>
        <p>Televizyonunuzda gördüğünüz 6 haneli eşleştirme kodunu girin:</p>
        <form method="POST" action="/activate">
          <input type="text" class="input-code" name="code" maxlength="6" required autofocus placeholder="123456"><br>
          <button type="submit" class="btn">TV'yi Bağla</button>
        </form>
        ${req.query.error ? `<div class="error">Geçersiz veya süresi dolmuş kod!</div>` : ''}
      </div>
    </body>
    </html>
  `);
});

app.post('/activate', (req, res) => {
  const sessionId = getCookie(req, 'proxy_session_id');
  const session = sessionId ? activeSessions[sessionId] : null;

  if (!session) return res.redirect('/activate');

  const code = req.body.code;
  if (!code || !pendingActivations[code]) {
    return res.redirect('/activate?error=1');
  }

  pendingActivations[code] = {
    status: 'activated',
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    timestamp: Date.now()
  };

  console.log(`[PAIRING] Successfully paired TV code ${code}`);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>tabii TV - Başarılı</title>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
      <style>
        body { background-color: #0b0f19; color: #ffffff; font-family: 'Outfit', sans-serif; margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
        .card { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.05); padding: 40px; border-radius: 20px; text-align: center; max-width: 400px; width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h1 { color: #00ffcc; margin-top: 0; }
        p { color: #8a99ad; line-height: 1.6; }
        .success-icon { font-size: 60px; color: #00ffcc; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="success-icon">✓</div>
        <h1>Eşleştirme Başarılı!</h1>
        <p>Televizyonunuz tabii hesabınıza başarıyla bağlandı. TV ekranından devam edebilirsiniz.</p>
      </div>
    </body>
    </html>
  `);
});

// tabii API Proxy
app.all('/eu1/*', async (req, res) => {
  const pathAfterEu1 = req.path.replace(/^\/eu1/, '');
  const targetUrl = 'https://eu1.tabii.com' + pathAfterEu1 + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  
  // Forward request headers
  const headers = { ...req.headers };
  headers['host'] = 'eu1.tabii.com';
  headers['origin'] = 'https://www.tabii.com';
  headers['referer'] = 'https://www.tabii.com/';
  headers['user-agent'] = PC_USER_AGENT;
  if (headers['cookie']) {
    headers['cookie'] = headers['cookie'].split(';').filter(c => !c.trim().startsWith('proxy_session_id=')).join(';');
  }
  
  const requestConfig = {
    method: req.method,
    url: targetUrl,
    headers: headers,
    data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
    responseType: 'json',
    validateStatus: () => true
  };

  try {
    const response = await axios(requestConfig);
    
    // Intercept login to store token
    if (req.path === '/eu1/apigateway/auth/v2/login' && response.status === 200 && response.data) {
      const loginData = response.data;
      if (loginData.accessToken) {
        console.log('[API PROXY] Intercepted successful login!');
        const sessionId = 'sess_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
        activeSessions[sessionId] = {
          accessToken: loginData.accessToken,
          refreshToken: loginData.refreshToken,
          timestamp: Date.now()
        };
        res.setHeader('Set-Cookie', `proxy_session_id=${sessionId}; Path=/; HttpOnly; Max-Age=31536000`);
      }
    }
    
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, val]) => {
      if (key.toLowerCase() !== 'content-length' && 
          key.toLowerCase() !== 'content-security-policy' && 
          key.toLowerCase() !== 'x-frame-options') {
        res.setHeader(key, val);
      }
    });
    
    res.json(response.data);
  } catch (err) {
    console.error(`[API PROXY ERROR] ${req.path} failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// custom endpoints for TV data fetching
app.get('/api/build-id', (req, res) => {
  res.json({ buildId: currentBuildId });
});

app.get('/api/home', async (req, res) => {
  try {
    const url = `https://www.tabii.com/_next/data/${currentBuildId}/tr.json`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': PC_USER_AGENT,
        'Accept': 'application/json'
      }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/detail/:id/:slug', async (req, res) => {
  const { id, slug } = req.params;
  try {
    const url = `https://www.tabii.com/_next/data/${currentBuildId}/tr/detail/${id}/${slug}.json`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': PC_USER_AGENT,
        'Accept': 'application/json'
      }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Expose static files of TV app as /tv path for backup or testing
app.use('/tv', express.static(path.join(__dirname, '../tabii-webos')));

// Main fallback reverse-proxy handler
app.all('*', async (req, res) => {
  if (req.path === '/_proxy/polyfills.js' || req.path === '/_proxy/log') return;

  const targetUrl = TABII_ORIGIN + req.url;
  
  const headers = { ...req.headers };
  headers['host'] = 'www.tabii.com';
  headers['user-agent'] = PC_USER_AGENT;
  
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
    
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, val]) => {
      if (key.toLowerCase() !== 'content-length' && 
          key.toLowerCase() !== 'content-security-policy' && 
          key.toLowerCase() !== 'x-frame-options') {
        res.setHeader(key, val);
      }
    });

    const contentType = response.headers['content-type'] || '';
    
    // Inject polyfills, clean scripts and rewrite basePath same-origin
    if (contentType.includes('html')) {
      let html = response.data.toString('utf8');
      
      const proxyOrigin = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
      html = html.replace(/https:\/\/eu1\.tabii\.com/g, `${proxyOrigin}/eu1`);
      
      const polyfillScript = '<script src="/_proxy/polyfills.js"></script>';
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${polyfillScript}`);
      } else {
        html = polyfillScript + html;
      }
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } else if (contentType.includes('javascript') || contentType.includes('application/x-javascript') || req.path.endsWith('.js')) {
      let jsContent = response.data.toString('utf8');
      const proxyOrigin = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
      jsContent = jsContent.replace(/https:\/\/eu1\.tabii\.com/g, `${proxyOrigin}/eu1`);
      res.setHeader('Content-Type', contentType || 'application/javascript; charset=utf-8');
      return res.send(jsContent);
    }

    return res.send(response.data);
  } catch (err) {
    console.error(`Proxy request failed to ${targetUrl}:`, err.message);
    res.status(500).send(`Proxy Error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`tabii webOS Proxy Server is running at http://localhost:${PORT}`);
  console.log(`Target: ${TABII_ORIGIN}`);
  console.log(`Target User-Agent (Spoofed): ${PC_USER_AGENT}`);
});
