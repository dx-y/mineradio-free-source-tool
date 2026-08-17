'use strict';

// ============================================================
//  免费音源 API 模块 v2
//  - GD Studio 聚合 API（主源：netease 播放地址稳定）
//  - Kuwo/Migu 搜索 + Netease 跨平台解析
//  - LX Music 服务器兜底
//  - 多源自动切换 + 健康检查
// ============================================================

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- 音源映射表 ----
const PLATFORM_MAP = {
  netease: 'wy', wy: 'wy',
  qq: 'tx', tx: 'tx',
  kugou: 'kg', kg: 'kg',
  kw: 'kw', kuwo: 'kw',
  mg: 'mg', migu: 'mg',
};

const QUALITY_MAP = {
  standard: '128k', exhigh: '320k', lossless: 'flac',
  hires: 'flac', jymaster: 'flac', jyeffect: 'flac', sky: 'flac',
  '128k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac24bit',
};

// ---- GD Studio API ----
const GD_API = 'https://music-api.gdstudio.xyz/api.php';

// ---- 默认服务器列表（LX Music 兜底） ----
const DEFAULT_SERVERS = [
  { url: 'https://88.lxmusic.xn--fiqs8s', key: 'lxmusic', priority: 1 },
  { url: 'https://lxmusic.ikunshare.com', key: 'lxmusic', priority: 2 },
];

// ---- 配置路径 ----
const CONFIG_PATH = path.join(__dirname, 'free-source-servers.json');

// ---- 运行时状态 ----
let servers = [...DEFAULT_SERVERS];
let configMtime = 0;
let healthyServers = new Map();
let blacklistedUntil = new Map();
let gdApiHealthy = true;

// ---- 加载配置文件 ----
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const stat = fs.statSync(CONFIG_PATH);
      if (stat.mtimeMs <= configMtime) return;
      configMtime = stat.mtimeMs;
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(raw);
      if (Array.isArray(config) && config.length > 0) {
        servers = config.map((s, i) => ({
          url: String(s.url || '').replace(/\/+$/, ''),
          key: String(s.key || 'lxmusic'),
          priority: Number(s.priority) || i + 1,
        })).filter(s => s.url.startsWith('http'));
        console.log('[FreeSource] Config loaded:', servers.length, 'servers');
      }
    }
  } catch (err) {
    console.error('[FreeSource] Config load error:', err.message);
  }
}
loadConfig();

// ---- HTTP 请求 ----
function httpRequest(urlStr, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 8000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body: null, error: 'parse_error', raw: body });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ---- GD Studio API 请求 ----
async function gdApi(params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const response = await httpRequest(GD_API + '?' + qs, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 10000,
  });
  if (response.status === 403) throw new Error('GD API forbidden');
  if (!response.body) throw new Error('GD API returned no data');
  return response.body;
}

// ---- 健康检查 ----
function isServerHealthy(serverUrl) {
  const until = blacklistedUntil.get(serverUrl);
  if (until && Date.now() < until) return false;
  return true;
}

function markServerFailure(serverUrl) {
  const entry = healthyServers.get(serverUrl) || { failures: 0, lastCheck: Date.now() };
  entry.failures++;
  entry.lastCheck = Date.now();
  healthyServers.set(serverUrl, entry);
  if (entry.failures >= 3) {
    const backoff = Math.min(entry.failures * 30000, 300000);
    blacklistedUntil.set(serverUrl, Date.now() + backoff);
    console.warn('[FreeSource] Blacklisted', serverUrl, 'for', backoff, 'ms');
  }
}

function markServerSuccess(serverUrl) {
  healthyServers.delete(serverUrl);
  blacklistedUntil.delete(serverUrl);
}

function getAvailableServers() {
  loadConfig();
  return servers
    .filter(s => isServerHealthy(s.url))
    .sort((a, b) => a.priority - b.priority);
}

// ============================================================
//  GD Studio 搜索（支持 netease / kuwo / kugou / tencent / bilibili）
// ============================================================
async function gdSearch(platform, keyword, page, limit) {
  const result = await gdApi({
    types: 'search',
    source: platform,
    name: keyword,
    count: limit || 20,
    pages: page || 1,
  });
  if (!Array.isArray(result)) {
    console.warn('[FreeSource] GD search unexpected format:', typeof result);
    return { list: [], total: 0 };
  }
  return {
    list: result.map(s => {
      var rawId = String(s.id || '');
      // Strip MUSIC_ prefix for clean ID (e.g., MUSIC_228908 → 228908)
      var cleanId = rawId.replace(/^MUSIC_/, '');
      return {
        id: cleanId,
        name: s.name || '',
        artist: Array.isArray(s.artist) ? s.artist.join('/') : String(s.artist || ''),
        album: s.album || '',
        mid: cleanId,
        provider: platform === 'kuwo' ? 'kw' : (platform === 'netease' ? 'wy' : platform),
        cover: s.pic_id ? 'https://music-api.gdstudio.xyz/static/cover/' + s.pic_id : '',
      };
    }),
    total: result.length,
  };
}

// ---- 酷我搜索（走 GD Studio） ----
async function searchKuwo(keyword, page, limit) {
  return await gdSearch('kuwo', keyword, page, limit);
}

// ---- 咪咕搜索（走 GD Studio netease 跨平台） ----
async function searchMigu(keyword, page, limit) {
  // GD Studio 没有直接 migu 源，用 netease 搜索 + 关键词匹配
  return await gdSearch('netease', keyword, page, limit);
}

// ---- GD Studio URL 解析（netease 稳定） ----
async function resolveGdUrl(source, songId, quality) {
  const br = quality === 'flac' || quality === 'lossless' ? 'flac' :
             quality === '320k' || quality === 'exhigh' ? '320' : '128';
  const result = await gdApi({
    types: 'url',
    source: source,
    id: songId,
    br: br,
  });
  if (result && result.url) {
    return {
      url: result.url,
      source: source,
      quality: quality,
      server: 'gdstudio',
    };
  }
  throw new Error('GD URL empty for ' + source + '/' + songId);
}

// ---- 酷我 URL 解析（走 GD Studio，空 URL 则跨平台到 netease） ----
async function resolveKwUrl(mid, quality) {
  // 酷我 URL 解析走 GD Studio，失败直接抛出由上层 crossResolve 按歌名处理
  return await resolveGdUrl('kuwo', mid, quality);
}

// ---- 咪咕 URL 解析（走 GD Studio netease） ----
async function resolveMgUrl(contentId, quality) {
  return await resolveGdUrl('netease', contentId, quality);
}

// ---- 本地网易云搜索（绕过 GD Studio，使用 Mineradio 自带的 Cookie） ----
async function nativeNeteaseSearch(keyword, limit) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const reqUrl = `http://127.0.0.1:${port}/api/search?keywords=${encodeURIComponent(keyword)}&limit=${limit || 10}`;
    const url = new URL(reqUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 10000,
    };
    const req = mod.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Native search timeout')); });
    req.end();
  });
}

// ---- 文本规范化（用于匹配） ----
function freeTextNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·\-_／/+,，。:：'"'']+/g, '');
}

// ---- 跨平台解析：搜酷我/咪咕歌曲 → netease 找播放地址 ----
async function crossResolve(platform, keyword, artist, quality) {
  // 1. GD Studio netease 搜索
  const searchQuery = keyword + (artist ? ' ' + artist.split('/')[0] : '');
  const result = await gdSearch('netease', searchQuery, 1, 5);
  if (result.list.length > 0) {
    const best = result.list[0];
    return await resolveGdUrl('netease', best.id, quality);
  }

  // 2. Mineradio 原生网易云搜索兜底（带 Cookie，覆盖更全）
  try {
    console.log('[FreeSource] GD search empty for "' + searchQuery + '", trying native netease...');
    const native = await nativeNeteaseSearch(keyword, 20);
    const songs = native.songs || [];
    const artistNorm = freeTextNorm(artist || '');
    if (songs.length > 0) {
      // 按歌手匹配
      let matched = null;
      if (artistNorm) {
        for (const s of songs) {
          const sa = freeTextNorm(String(s.artist || s.singer || ''));
          if (sa.includes(artistNorm) || artistNorm.includes(sa)) {
            matched = s;
            break;
          }
        }
      }
      // 无歌手匹配则取第一首
      const target = matched || songs[0];
      console.log('[FreeSource] Native search matched:', target.name, target.artist, '(id:', target.id, ')');
      return await resolveGdUrl('netease', String(target.id), quality);
    }
  } catch (e) {
    console.warn('[FreeSource] Native search fallback failed:', e.message);
  }

  throw new Error('Cross-resolve: no match found on netease');
}

// ---- 直接平台解析 ----
async function resolveDirectPlatform(platform, songId, quality) {
  try {
    if (platform === 'kw' || platform === 'kuwo') {
      return await resolveKwUrl(songId, quality);
    }
    if (platform === 'mg' || platform === 'migu') {
      return await resolveMgUrl(songId, quality);
    }
    if (platform === 'tx' || platform === 'qq') {
      return await resolveGdUrl('tencent', songId, quality);
    }
    if (platform === 'kg' || platform === 'kugou') {
      return await resolveGdUrl('kugou', songId, quality);
    }
    if (platform === 'wy' || platform === 'netease') {
      return await resolveGdUrl('netease', songId, quality);
    }
  } catch (e) {
    console.warn('[FreeSource] Direct ' + platform + ' failed:', e.message);
  }
  return null;
}

// ---- 核心：解析歌曲 URL ----
async function resolveFreeUrl(platform, songId, quality, name, artist) {
  // 1. 优先 GD Studio 直接解析
  const direct = await resolveDirectPlatform(platform, songId, quality);
  if (direct) {
    gdApiHealthy = true;
    console.log('[FreeSource] Resolved via GD:', platform, songId);
    return direct;
  }

  // 2. GD 解析失败（如 kuwo URL 为空），跨平台 netease 搜索（用歌名+歌手而非 ID）
  if (platform === 'kw' || platform === 'kuwo' || platform === 'mg' || platform === 'migu') {
    try {
      const crossKeyword = (name || songId).trim();
      const cross = await crossResolve(platform, crossKeyword, artist || '', quality);
      if (cross) {
        gdApiHealthy = true;
        console.log('[FreeSource] Cross-resolved:', platform, songId, '→ netease');
        return cross;
      }
    } catch (e) {
      console.warn('[FreeSource] Cross-resolve failed:', e.message);
    }
  }

  // 3. LX Music 服务器兜底
  const lxPlatform = PLATFORM_MAP[platform] || 'wy';
  const lxQuality = QUALITY_MAP[quality] || '320k';
  const available = getAvailableServers();
  if (available.length) {
    let lastError = null;
    for (const server of available) {
      try {
        const urlPath = `/lxmusicv3/url/${lxPlatform}/${encodeURIComponent(songId)}/${lxQuality}`;
        const response = await httpRequest(server.url + urlPath, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'lx-music-request/mineradio',
            'X-Request-Key': server.key,
          },
          timeout: 10000,
        });
        if (response.body && response.body.code === 0 && response.body.data) {
          markServerSuccess(server.url);
          console.log('[FreeSource] Resolved via LX:', platform, songId);
          return {
            url: String(response.body.data),
            source: lxPlatform,
            quality: lxQuality,
            server: server.url,
          };
        }
        if (response.body && (response.body.code === 4 || response.body.code === 5)) {
          markServerFailure(server.url);
          lastError = new Error('Server error: ' + (response.body.msg || 'internal'));
        } else {
          lastError = new Error('Not available: code=' + (response.body ? response.body.code : 'unknown'));
        }
      } catch (err) {
        markServerFailure(server.url);
        lastError = err;
      }
    }
    throw lastError || new Error('All servers exhausted');
  }

  gdApiHealthy = false;
  throw new Error('No free source available for ' + platform);
}

// ---- 批量探测：尝试多个平台 ----
async function resolveFreeUrlMultiPlatform(songInfo, preferredPlatforms, quality) {
  const platforms = preferredPlatforms || ['tx', 'wy', 'kg', 'kw', 'mg'];
  for (const platform of platforms) {
    const songId = getSongIdForPlatform(songInfo, platform);
    if (!songId) continue;
    try {
      const result = await resolveFreeUrl(platform, songId, quality);
      return result;
    } catch (err) {
      // Try next platform
    }
  }
  return null;
}

function getSongIdForPlatform(songInfo, lxPlatform) {
  switch (lxPlatform) {
    case 'tx': return songInfo.songmid || songInfo.mid || songInfo.id || '';
    case 'wy': return String(songInfo.id || songInfo.songId || '');
    case 'kg': return songInfo.hash || songInfo.fileHash || songInfo.audioHash || '';
    case 'kw': return songInfo.songmid || songInfo.id || '';
    case 'mg': return songInfo.songmid || songInfo.id || songInfo.contentId || '';
    default: return '';
  }
}

// ---- 搜索聚合 ----
async function searchFreeSource(platform, keyword, page, limit) {
  // 通过 GD Studio 搜索
  const gdPlatform = (platform === 'kw' || platform === 'kuwo') ? 'kuwo' :
                      (platform === 'mg' || platform === 'migu') ? 'netease' :
                      (platform === 'tx' || platform === 'qq') ? 'tencent' :
                      (platform === 'kg' || platform === 'kugou') ? 'kugou' : 'netease';
  return await gdSearch(gdPlatform, keyword, page, limit);
}

// ---- 服务器管理 API ----
function getServerStatus() {
  return {
    gdApi: { healthy: gdApiHealthy, url: GD_API },
    servers: servers.map(s => ({
      ...s,
      healthy: isServerHealthy(s.url),
      failures: (healthyServers.get(s.url) || {}).failures || 0,
      blacklistedUntil: blacklistedUntil.get(s.url) || null,
    })),
    configPath: CONFIG_PATH,
  };
}

function reloadConfig() {
  configMtime = 0;
  healthyServers.clear();
  blacklistedUntil.clear();
  gdApiHealthy = true;
  loadConfig();
  return getServerStatus();
}

module.exports = {
  resolveFreeUrl,
  resolveFreeUrlMultiPlatform,
  getServerStatus,
  reloadConfig,
  searchFreeSource,
  searchKuwo,
  searchMigu,
  PLATFORM_MAP,
  QUALITY_MAP,
  getSongIdForPlatform,
  gdApiHealthy: () => gdApiHealthy,
};
