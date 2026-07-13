const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();

// Raw body parser for DRM (Widevine binary protobuf) - MUST be before JSON parser
app.use('/eu1/apigateway/drm', express.raw({ type: '*/*', limit: '2mb' }));
app.use('/apigateway/drm', express.raw({ type: '*/*', limit: '2mb' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Global CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, App-Version, Platform, Device-Model, Device-Name, Device-Type, Device-OS-Version, Device-OS-Name, Device-Language, Device-Brand, Device-Resolution, Device-Orientation, Device-Network, Device-Connection-Type, Device-Timezone, Accept, Origin, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 10000;
const TABII_ORIGIN = 'https://www.tabii.com';
const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Global Session Stores for TV Pairing
const activeSessions = {}; // session_id -> { accessToken, refreshToken, timestamp }
const pendingActivations = {}; // 6-digit-code -> { status, accessToken, refreshToken, timestamp }
let registeredLocalProxyUrl = null; // Local tunnel URL (for passing DRM Widevine requests to residential IP)
let registeredLocalIp = null; // Local PC IP address (for direct LAN DRM requests from TV)

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

      if (win.Element && !win.Element.prototype.matches) {
        win.Element.prototype.matches = 
          win.Element.prototype.matchesSelector || 
          win.Element.prototype.mozMatchesSelector || 
          win.Element.prototype.msMatchesSelector || 
          win.Element.prototype.oMatchesSelector || 
          win.Element.prototype.webkitMatchesSelector || 
          function(s) {
            var matches = (this.document || this.ownerDocument).querySelectorAll(s),
                i = matches.length;
            while (--i >= 0 && matches.item(i) !== this) {}
            return i > -1;            
          };
      }

      if (win.Element && !win.Element.prototype.closest) {
        win.Element.prototype.closest = function(s) {
          var el = this;
          do {
            if (win.Element.prototype.matches.call(el, s)) return el;
            el = el.parentElement || el.parentNode;
          } while (el !== null && el.nodeType === 1);
          return null;
        };
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

      console.log("ES5 core polyfills loaded successfully.");
    })(window);
  `;
  res.send(combined);
});

// Image Proxy to avoid CORS/SSL issues on older TVs with memory optimizations
app.get('/_proxy/image/:name', async (req, res) => {
  const width = req.query.w || '300';
  const optimizedUrl = `https://cms-tabii-public-image.tabii.com/int/jpeg/w${width}/q50/${req.params.name}`;
  const rawUrl = `https://cms-tabii-public-image.tabii.com/int/${req.params.name}`;
  
  try {
    const response = await axios.get(optimizedUrl, {
      responseType: 'stream',
      headers: { 'User-Agent': PC_USER_AGENT }
    });
    res.setHeader('Content-Type', 'image/jpeg');
    response.data.pipe(res);
  } catch (err) {
    try {
      const response = await axios.get(rawUrl, {
        responseType: 'stream',
        headers: { 'User-Agent': PC_USER_AGENT }
      });
      res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
      response.data.pipe(res);
    } catch (rawErr) {
      res.sendStatus(404);
    }
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
app.get(['/activate', '/*/activate'], (req, res) => {
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
          <p>Oturumunuz algılanamadı. Lütfen önce Ana Sayfaya giderek oturumunuzu doğrulayın.</p>
          <a class="btn" href="/">Ana Sayfaya Git</a>
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
          <input type="text" class="input-code" name="code" maxlength="6" required autofocus autocomplete="off" placeholder="123456"><br>
          <button type="submit" class="btn">TV'yi Bağla</button>
        </form>
        ${req.query.error ? `<div class="error">Geçersiz veya süresi dolmuş kod!</div>` : ''}
      </div>
    </body>
    </html>
  `);
});

app.post(['/activate', '/*/activate'], express.urlencoded({ extended: true }), (req, res) => {
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

// Dynamic registration of local proxy for cloud-to-local DRM routing
app.get('/_proxy/register-local', (req, res) => {
  const url = req.query.url;
  if (url) {
    registeredLocalProxyUrl = url.replace(/\/$/, '');
    console.log(`[PROXY REGISTRATION] Registered local proxy URL: ${registeredLocalProxyUrl}`);
    return res.json({ success: true, registeredUrl: registeredLocalProxyUrl });
  }
  return res.status(400).json({ error: 'Missing url parameter' });
});

// Endpoint to clear all session cookies and force logout
app.get('/_proxy/clear-session', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('session');
  res.clearCookie('proxy_session_id');
  console.log('[SESSION] Session cookies cleared via clear-session endpoint');
  res.redirect('/');
});

// Dynamic registration of local PC IP address for direct LAN DRM routing
app.get('/_proxy/register-local-ip', (req, res) => {
  const ip = req.query.ip;
  if (ip) {
    registeredLocalIp = ip.trim();
    console.log(`[IP REGISTRATION] Registered local PC IP: ${registeredLocalIp}`);
    return res.json({ success: true, registeredIp: registeredLocalIp });
  }
  return res.status(400).json({ error: 'Missing ip parameter' });
});

app.get('/_proxy/get-local-ip', (req, res) => {
  res.json({ ip: registeredLocalIp });
});

// ── DRM PROXY (binary passthrough – MUST be before general API proxy) ────────
app.all(['/eu1/apigateway/drm/*', '/apigateway/drm/*'], async (req, res) => {
  let pathAfterDomain = req.path.startsWith('/eu1/') ? req.path.replace(/^\/eu1/, '') : req.path;
  // Strip cache-buster so the real backend doesn't reject the ticket
  const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')).replace(/[?&]_cb=[^&]*/g, '').replace(/^&/, '?') : '';
  
  let targetUrl;
  let useLocalProxy = false;
  
  // If we are running in the cloud (not on user's local network/localhost) and have a registered local proxy, route the DRM challenge to it.
  const host = req.headers.host || '';
  if (registeredLocalProxyUrl && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.includes('192.168.')) {
    // Forward directly to the local tunnel URL (ngrok)
    targetUrl = registeredLocalProxyUrl + (req.path.startsWith('/eu1/') ? req.path : '/eu1' + req.path) + queryString;
    useLocalProxy = true;
    console.log(`[DRM PROXY] Routing cloud DRM request to local residential proxy: ${targetUrl}`);
  } else {
    targetUrl = 'https://eu1.tabii.com' + pathAfterDomain + queryString;
  }

  const headers = {
    'host': useLocalProxy ? new URL(registeredLocalProxyUrl).host : 'eu1.tabii.com',
    'origin': 'https://www.tabii.com',
    'referer': 'https://www.tabii.com/',
    'user-agent': PC_USER_AGENT,
    'content-type': 'application/octet-stream',
    'accept': '*/*',
  };
  if (req.headers.authorization) headers['authorization'] = req.headers.authorization;
  if (req.headers['app-version']) headers['app-version'] = req.headers['app-version'];

  console.log(`[DRM PROXY] ${req.method} ${req.path} -> ${targetUrl} (local proxy: ${useLocalProxy})`);

  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      headers: headers,
      data: req.body,          // raw Buffer from express.raw()
      responseType: 'arraybuffer',
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log(`[DRM PROXY] Response status: ${response.status} | Content-Type: ${response.headers['content-type'] || 'unknown'} | Body size: ${response.data ? response.data.length : 0} bytes`);
    if (response.status !== 200) {
      // Log raw body for debugging
      try {
        const bodyText = response.data ? response.data.toString('utf8').substring(0, 500) : '(empty)';
        console.error(`[DRM PROXY] Non-200 response body: ${bodyText}`);
      } catch (logErr) {}
    }
    res.status(response.status);
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.send(response.data);
  } catch (err) {
    console.error('[DRM PROXY ERROR]', err.message);
    res.status(502).json({ error: 'DRM proxy failed', detail: err.message });
  }
});

// tabii API Proxy
app.all(['/eu1/*', '/apigateway/*', '/cw-writer/*', '/watching-device/*'], async (req, res) => {
  let pathAfterDomain = req.path;
  if (req.path.startsWith('/eu1/')) {
    pathAfterDomain = req.path.replace(/^\/eu1/, '');
  }
  // Strip our cache-buster param (_cb) before forwarding to upstream
  let rawQuery = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  rawQuery = rawQuery.replace(/[?&]_cb=[^&]*/g, '').replace(/^&/, '?');
  const targetUrl = 'https://eu1.tabii.com' + pathAfterDomain + rawQuery;

  // Intercept profile token request to bypass 401 error
  if (req.method === 'POST' && pathAfterDomain.match(/\/apigateway\/profiles\/v2\/[^\/]+\/token/)) {
    console.log('[PROXY BYPASS] Intercepting profile token select request to return 200 OK');
    const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : '';
    return res.json({ accessToken: token });
  }
  
  // HARVEST TOKEN: If the browser is sending an Authorization header, capture it!
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const token = req.headers.authorization.split(' ')[1];
    let sessionId = getCookie(req, 'proxy_session_id');
    if (!sessionId) {
      sessionId = 'sess_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      res.setHeader('Set-Cookie', `proxy_session_id=${sessionId}; Path=/; HttpOnly; Max-Age=31536000`);
    }
    activeSessions[sessionId] = {
      accessToken: token,
      timestamp: Date.now()
    };
  }

  // Forward request headers
  const headers = { ...req.headers };
  headers['host'] = 'eu1.tabii.com';
  headers['origin'] = 'https://www.tabii.com';
  headers['referer'] = 'https://www.tabii.com/';
  headers['user-agent'] = PC_USER_AGENT;
  if (headers['cookie']) {
    headers['cookie'] = headers['cookie'].split(';').filter(c => !c.trim().startsWith('proxy_session_id=')).join(';');
  }
  
  console.log(`[PROXY REQUEST] ${req.method} ${req.path} -> ${targetUrl}`);
  console.log(`[PROXY HEADERS]`, headers);

  const requestConfig = {
    method: req.method,
    url: targetUrl,
    headers: headers,
    data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
    responseType: 'arraybuffer',
    validateStatus: () => true
  };

  try {
    const response = await axios(requestConfig);
    console.log(`[PROXY RESPONSE] ${req.path} -> Status ${response.status}`);

    let responseData = response.data;
    let decodedJson = null;
    
    // Try to decode as JSON for intercept logic if the content type is JSON
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/json') || req.path.includes('/token') || req.path.includes('/login')) {
      try {
        decodedJson = JSON.parse(response.data.toString('utf8'));
      } catch (e) {}
    }

    if (req.path.includes('/token') && decodedJson) {
      console.log(`[PROXY /token PAYLOAD]`, decodedJson);
    }

    // Auto-clear invalid session cookies on 401 ONLY for critical auth endpoints
    if ((req.path.includes('/auth/v2/me') || req.path.includes('/token/refresh') || req.path.includes('/token')) && 
        (response.status === 401 || (decodedJson && decodedJson.errorCode === 'invalidSession'))) {
      console.log(`[PROXY AUTO-LOGOUT] Detected invalid session on ${req.path}. Clearing proxy cookies.`);
      res.clearCookie('token');
      res.clearCookie('session');
      res.clearCookie('proxy_session_id');
    }
    
    // Intercept login to store token
    if ((req.path === '/eu1/apigateway/auth/v2/login' || req.path === '/apigateway/auth/v2/login') && response.status === 200 && decodedJson) {
      if (decodedJson.accessToken) {
        console.log('[API PROXY] Intercepted successful login!');
        const sessionId = getCookie(req, 'proxy_session_id') || ('sess_' + Math.random().toString(36).substring(2) + Date.now().toString(36));
        activeSessions[sessionId] = {
          accessToken: decodedJson.accessToken,
          refreshToken: decodedJson.refreshToken,
          timestamp: Date.now()
        };
        // Don't overwrite existing Set-Cookie if we already set one above
        if (!res.getHeader('Set-Cookie')) {
          res.setHeader('Set-Cookie', `proxy_session_id=${sessionId}; Path=/; HttpOnly; Max-Age=31536000`);
        }
      }
    }
    
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, val]) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'content-length' && 
          lowerKey !== 'content-security-policy' && 
          lowerKey !== 'x-frame-options' &&
          !lowerKey.startsWith('access-control-')) {
        res.setHeader(key, val);
      }
    });
    
    res.send(responseData);
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
  console.log(`[CUSTOM API] Fetching home catalog from Tabii (buildId: ${currentBuildId})...`);
  try {
    const url = `https://www.tabii.com/_next/data/${currentBuildId}/tr.json`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': PC_USER_AGENT,
        'Accept': 'application/json'
      }
    });
    console.log(`[CUSTOM API] Home catalog fetched successfully.`);
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
