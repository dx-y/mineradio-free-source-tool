'use strict';

// ============================================================
//  LX Music 音源脚本运行器
//  在 Node.js VM 中执行 LX Music v2 源脚本
//  提供 search / getMusicUrl / getMusicInfo 统一接口
// ============================================================

const vm = require('vm');
const https = require('https');
const http = require('http');
const urlModule = require('url');
const crypto = require('crypto');

// ---- 音源脚本列表 ----
const SOURCE_SCRIPTS = [
  {
    name: 'LX 官方源',
    key: 'lx',
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/lx/latest.js',
  },
  {
    name: '六音',
    key: 'sixyin',
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js',
  },
  {
    name: 'Huibq',
    key: 'huibq',
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
  },
  {
    name: '野花',
    key: 'flower',
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/flower/latest.js',
  },
  {
    name: 'ikun',
    key: 'ikun',
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/ikun/latest.js',
  },
  {
    name: '野草',
    key: 'grass',
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/grass/latest.js',
  },
];

// ---- LX Music 平台映射 ----
const PLATFORM_MAP = {
  wy: 'wy', netease: 'wy',
  tx: 'tx', qq: 'tx', tencent: 'tx',
  kg: 'kg', kugou: 'kg',
  kw: 'kw', kuwo: 'kw',
  mg: 'mg', migu: 'mg',
};

// ---- 运行时状态 ----
let sources = {};
let sourceStatus = {};
let _initialized = false;

// ---- HTTP 请求（供脚本使用）----
function _lxHttpRequest(urlStr, options, callback) {
  const parsed = urlModule.parse(urlStr);
  const mod = parsed.protocol === 'https:' ? https : http;
  const reqOpts = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.path,
    method: (options && options.method) || 'GET',
    headers: Object.assign({
      'User-Agent': 'lx-music/2.10.0',
    }, (options && options.headers) || {}),
    timeout: 12000,
  };

  const req = mod.request(reqOpts, (res) => {
    let chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks);
      const resp = {
        statusCode: res.statusCode,
        headers: res.headers,
        body: body,
        json: function() {
          try { return JSON.parse(body.toString('utf-8')); } catch (e) { return null; }
        },
      };
      callback(null, resp, body);
    });
  });
  req.on('error', (err) => callback(err));
  req.on('timeout', () => { req.destroy(); callback(new Error('timeout')); });
  if (options && options.body) {
    req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  }
  req.end();
}

// ---- 构建沙箱 ----
function _createSandbox(sourceMeta) {
  const pendingResponses = new Map();
  let requestHandler = null;

  const sandbox = {
    // 基本环境
    console: {
      log: function() {},
      error: function() {},
      warn: function() {},
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Promise: Promise,
    Date: Date,
    Math: Math,
    JSON: JSON,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    RegExp: RegExp,
    Error: Error,
    Map: Map,
    Buffer: Buffer,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
    encodeURI: encodeURI,
    decodeURI: decodeURI,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    // 全局作用域
    globalThis: {},
  };

  // LX Music API
  sandbox.globalThis.lx = {
    EVENT_NAMES: { request: 'request' },

    request: function(url, options, callback) {
      if (typeof options === 'function' && !callback) {
        callback = options;
        options = {};
      }
      _lxHttpRequest(url, options, callback);
    },

    on: function(eventName, handler) {
      if (eventName === 'request') {
        requestHandler = handler;
      }
    },

    send: function(channel, data) {
      // 脚本通过 send 返回结果
      pendingResponses.set(channel, data);
    },

    env: 'mobile',
    version: '2.10.0',
    currentScriptInfo: {
      name: sourceMeta.name,
      version: '1.0.0',
      author: '',
      description: '',
      raw: sourceMeta.url,
    },

    utils: {
      crypto: {
        md5: function(str) {
          return crypto.createHash('md5').update(String(str)).digest('hex');
        },
        sha1: function(str) {
          return crypto.createHash('sha1').update(String(str)).digest('hex');
        },
      },
      base64: {
        encode: function(str) {
          return Buffer.from(String(str)).toString('base64');
        },
        decode: function(str) {
          return Buffer.from(String(str), 'base64').toString('utf-8');
        },
      },
    },
  };

  // 使其在沙箱内部可访问
  sandbox.globalThis.globalThis = sandbox.globalThis;
  sandbox.global = sandbox.globalThis;

  return { sandbox, getRequestHandler: () => requestHandler, pendingResponses };
}

// ---- 加载单个脚本 ----
function _loadSource(meta) {
  return new Promise((resolve, reject) => {
    const parsed = urlModule.parse(meta.url);
    const mod = parsed.protocol === 'https:' ? https : http;
    mod.get(meta.url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const code = Buffer.concat(chunks).toString('utf-8');
        resolve(code);
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// ---- 执行脚本并提取搜索/URL方法 ----
function _executeSource(meta, code) {
  return new Promise((resolve, reject) => {
    try {
      const { sandbox, getRequestHandler, pendingResponses } = _createSandbox(meta);
      const ctx = vm.createContext(sandbox);

      // 执行脚本
      const script = new vm.Script(code, {
        filename: meta.url,
        timeout: 30000,
      });

      script.runInContext(ctx, { timeout: 30000 });

      // 等待脚本注册 handler
      let waitCount = 0;
      const checkHandler = setInterval(() => {
        const handler = getRequestHandler();
        waitCount++;

        if (handler) {
          clearInterval(checkHandler);

          // 包一层 search 函数
          const searchFn = (keyword, page, type) => {
            return new Promise((sResolve, sReject) => {
              try {
                pendingResponses.delete('search');
                const searchKey = meta.key + '_search_' + Date.now();

                // 模拟 LX Music 搜索事件
                handler({
                  source: searchKey,
                  action: 'search',
                  info: {
                    type: type || 'music',
                    keyword: keyword,
                    page: page || 1,
                    limit: 20,
                  },
                });

                // LX Music v2 脚本通过 send 返回
                // 但有些脚本通过 lx.request 回调直接处理
                // 等待 pendingResponses
                let checkCount = 0;
                const checkResp = setInterval(() => {
                  checkCount++;
                  const resp = pendingResponses.get('search');
                  if (resp) {
                    clearInterval(checkResp);
                    sResolve(resp);
                    return;
                  }
                  if (checkCount > 40) {
                    clearInterval(checkResp);
                    sReject(new Error('search timeout'));
                  }
                }, 250);
                sResolve._timer = checkResp;
              } catch (e) {
                sReject(e);
              }
            });
          };

          // musicUrl 函数
          const musicUrlFn = (songInfo, quality) => {
            return new Promise((uResolve, uReject) => {
              try {
                pendingResponses.delete('musicUrl');
                pendingResponses.delete('url');

                const musicKey = meta.key + '_url_' + Date.now();

                handler({
                  source: musicKey,
                  action: 'musicUrl',
                  info: {
                    type: songInfo._type || 'music',
                    musicInfo: songInfo,
                  },
                });

                let checkCount = 0;
                const checkResp = setInterval(() => {
                  checkCount++;
                  const resp = pendingResponses.get('musicUrl') || pendingResponses.get('url');
                  if (resp) {
                    clearInterval(checkResp);
                    uResolve(resp);
                    return;
                  }
                  if (checkCount > 40) {
                    clearInterval(checkResp);
                    uReject(new Error('musicUrl timeout'));
                  }
                }, 250);
                uResolve._timer = checkResp;
              } catch (e) {
                uReject(e);
              }
            });
          };

          resolve({ search: searchFn, musicUrl: musicUrlFn, meta, ctx });
        } else if (waitCount > 40) {
          clearInterval(checkHandler);
          reject(new Error('handler not registered'));
        }
      }, 500);
    } catch (e) {
      reject(e);
    }
  });
}

// ---- 初始化所有音源 ----
async function init() {
  if (_initialized) return;

  console.log('[LxRunner] Initializing', SOURCE_SCRIPTS.length, 'sources...');
  const results = [];

  for (const meta of SOURCE_SCRIPTS) {
    try {
      sourceStatus[meta.key] = { status: 'loading', name: meta.name, error: null };
      const code = await _loadSource(meta);
      const source = await _executeSource(meta, code);
      sources[meta.key] = source;
      sourceStatus[meta.key] = { status: 'ready', name: meta.name, error: null };
      results.push({ key: meta.key, ok: true });
      console.log('[LxRunner] Loaded:', meta.name);
    } catch (err) {
      sourceStatus[meta.key] = { status: 'failed', name: meta.name, error: err.message };
      results.push({ key: meta.key, ok: false, error: err.message });
      console.error('[LxRunner] Failed', meta.name + ':', err.message);
    }
  }

  _initialized = true;
  console.log('[LxRunner] Init done:', results.filter(r => r.ok).length + '/' + results.length, 'sources ready');
  return results;
}

// ---- 搜索 ----
async function search(keyword, page, type) {
  if (!_initialized) await init();

  const allResults = [];
  const limit = type === 'album' ? 10 : 20;

  for (const [key, source] of Object.entries(sources)) {
    try {
      const result = await Promise.race([
        source.search(keyword, page || 1, type || 'music'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      if (result && Array.isArray(result.list)) {
        result.list.forEach((item) => {
          item._sourceKey = key;
          item._sourceName = source.meta.name;
        });
        allResults.push(result);
      }
    } catch (err) {
      // 该源搜索失败，继续下一个
    }
  }

  // 合并去重
  const merged = [];
  const seen = new Set();
  for (const result of allResults) {
    for (const item of (result.list || [])) {
      const hash = crypto.createHash('md5').update(
        (item.name || item.title || '') + '|' + (item.artist || item.singer || '')
      ).digest('hex');
      if (!seen.has(hash)) {
        seen.add(hash);
        merged.push(item);
      }
    }
  }

  return {
    list: merged.slice(0, limit),
    total: merged.length,
    limit: limit,
    sources: allResults.length,
  };
}

// ---- 获取播放URL ----
async function getMusicUrl(songInfo, quality) {
  if (!_initialized) await init();

  const sourceKey = songInfo._sourceKey;
  const q = quality || '320k';

  // 如果指定了源，优先用该源
  if (sourceKey && sources[sourceKey]) {
    try {
      const urlResult = await Promise.race([
        sources[sourceKey].musicUrl(songInfo, q),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      if (urlResult && urlResult.url) return urlResult;
    } catch (e) { /* fall through */ }
  }

  // 遍历所有源
  for (const [key, source] of Object.entries(sources)) {
    if (key === sourceKey) continue;
    try {
      const urlResult = await Promise.race([
        source.musicUrl(songInfo, q),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      if (urlResult && urlResult.url) return urlResult;
    } catch (e) { /* continue */ }
  }

  return null;
}

// ---- 获取音源状态 ----
function getStatus() {
  return {
    initialized: _initialized,
    sourceCount: Object.keys(sources).length,
    sources: Object.entries(sourceStatus).map(([key, st]) => ({
      key,
      name: st.name,
      status: st.status,
      error: st.error,
    })),
  };
}

// ---- 导出 ----
module.exports = {
  init,
  search,
  getMusicUrl,
  getStatus,
  SOURCE_SCRIPTS,
};
