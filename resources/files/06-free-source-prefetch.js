// ==================== Mineradio 后台免费源预扫描（ID 映射） ====================
// 职责：
//   1. 检测登录后，静默拉取歌单（收藏 + 自建）
//   2. 用歌单接口自带的 vip/付费标记筛出需换源的歌
//   3. 分批节流预搜酷我/咪咕，建立「原曲ID -> 免费源平台 + 免费源歌曲ID」映射
//   4. 本地持久化映射缓存（仅 ID，不存签名 URL）
//   5. 播放时命中映射直接按免费源 ID 取 URL（跳过现场搜同名曲）
// 硬约束：只建 ID 映射不预存 URL；预搜分批限速；后台低优先级；歌单增量补扫。

var FREE_ID_MAP_STORAGE_KEY = 'mr_free_id_map_v2';
var FREE_ID_MAP_MAX_ENTRIES = 3000;
var FREE_ID_MAP_TTL_MS = 30 * 24 * 3600 * 1000;
var FREE_SOURCE_PREFETCH_TICK_MS = 20000;
var FREE_SOURCE_PREFETCH_INIT_DELAY_MS = 2000; // 启动即恢复：缩短至 2s，尽快进入保鲜检查与全量扫描
var FREE_SOURCE_PREFETCH_RESIGNATURE_MS = 10 * 60 * 1000;
var FREE_SOURCE_PREFETCH_MAX_PER_RUN = 120;
var FREE_SOURCE_PREFETCH_SEARCH_GAP_MS = 1500;
var FREE_SOURCE_PREFETCH_PLATFORM_GAP_MS = 800;
var FREE_SOURCE_PREFETCH_PLAYLIST_GAP_MS = 700;
var FREE_SOURCE_PREFETCH_PAGE_GAP_MS = 500;
var FREE_SOURCE_PREFETCH_PLAYLIST_WAIT_MS = 2500; // 歌单就绪轮询间隔
var FREE_SOURCE_PREFETCH_PLAYLIST_WAIT_MAX = 80;  // 最多等待 200s，超时交给 tick 兜底

// ---- 免费源播放 URL 预取缓存（本次升级新增） ----
// 预扫描建 ID 映射的同时，并发限速预取播放 URL 并本地持久化（记录取 URL 时间戳 + TTL）。
// 播放时命中未过期 URL 直接返回，消除 GD Studio 约 2.8s 的实时解析延迟。
var FREE_URL_CACHE_STORAGE_KEY = 'mr_free_url_cache_v1';
var FREE_URL_CACHE_MAX_ENTRIES = 3000;
var FREE_URL_CACHE_TTL_MS = 90 * 60 * 1000; // 90 分钟，签名 URL 过期前主动失效（保鲜刷新保证缓存新鲜）
var FREE_URL_PREFETCH_MAX_CONCURRENCY = 2;   // 并发取 URL 上限，避免压垮 GD API
var FREE_URL_PREFETCH_MAX_PER_RUN = 60;      // 单轮预取上限节流
var FREE_URL_PREFETCH_GAP_MS = 420;          // 每次取 URL 之间的最小间隔
var FREE_URL_PREFETCH_RETRY_GAP_MS = 900;    // 失败后重试间隔

var freeSourcePrefetchState = {
  running: false,
  searching: false,
  lastLoginState: false,
  lastScanAt: 0,
  playlistSignatures: Object.create(null),
  scanQueue: [],
  scanIndex: 0,
  searchQueue: [],
  tickTimer: 0,
  pendingRescan: false,
  pendingFullScan: false,
  urlQueue: [],
  urlInFlight: 0,
  urlFetching: false,
  urlPrefetchedThisRun: 0,
  playlistEnsureRunning: false, // 歌单就绪轮询防重入：避免多个 tick 并发重复触发 refreshUserPlaylists
};

function loadFreeIdMap() {
  try {
    var raw = localStorage.getItem(FREE_ID_MAP_STORAGE_KEY);
    if (!raw) return { version: 2, entries: {} };
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: 2, entries: {} };
    if (!parsed.entries || typeof parsed.entries !== 'object') parsed.entries = {};
    parsed.version = 2;
    return parsed;
  } catch (e) {
    return { version: 2, entries: {} };
  }
}

function saveFreeIdMap(map) {
  try {
    var entries = map.entries || {};
    var keys = Object.keys(entries);
    if (keys.length > FREE_ID_MAP_MAX_ENTRIES) {
      keys.sort(function (a, b) { return (entries[b].ts || 0) - (entries[a].ts || 0); });
      var trimmed = {};
      for (var i = 0; i < FREE_ID_MAP_MAX_ENTRIES; i++) trimmed[keys[i]] = entries[keys[i]];
      map.entries = trimmed;
    }
    localStorage.setItem(FREE_ID_MAP_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {}
}

function freeIdMapKey(song) {
  var provider = (typeof songProviderKey === 'function' ? songProviderKey(song) : (song.provider || ''));
  var id = song.id || song.mid || song.songmid || song.mediaMid || song.media_mid || song.hash || '';
  return (provider || 'unknown') + '::' + id;
}

// 播放时查询：命中映射则返回免费源歌曲对象（仅 ID 映射，URL 由播放链路实时解析）
function getMappedFreeSong(song) {
  if (!song) return null;
  var map = loadFreeIdMap();
  var key = freeIdMapKey(song);
  var entry = map.entries[key];
  if (!entry || !entry.fid || !entry.fp) return null;
  if (Date.now() - (entry.ts || 0) > FREE_ID_MAP_TTL_MS) {
    delete map.entries[key];
    saveFreeIdMap(map);
    return null;
  }
  var mapped = {
    provider: 'free',
    __freePlatform: entry.fp,
    name: entry.name || song.name || song.title || '',
    artist: entry.artist || song.artist || '',
  };
  if (typeof songProviderKey === 'function') mapped.__providerKey = 'free';
  if (entry.fp === 'kw' || entry.fp === 'kuwo') {
    mapped.mid = entry.fid;
    mapped.songmid = entry.fid;
  } else {
    mapped.id = entry.fid;
    mapped.songmid = entry.fid;
  }
  mapped.__lyricId = song.id || song.mid || song.songmid || '';
  mapped.__lyricProvider = (typeof songProviderKey === 'function' ? songProviderKey(song) : (song.provider || 'netease'));
  mapped.__fromFreeIdMap = true;
  return mapped;
}

// ---- 免费源播放 URL 缓存（全局函数，供播放链路命中 0 等待） ----
function loadFreeUrlCache() {
  try {
    var raw = localStorage.getItem(FREE_URL_CACHE_STORAGE_KEY);
    if (!raw) return { version: 1, entries: {} };
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: 1, entries: {} };
    if (!parsed.entries || typeof parsed.entries !== 'object') parsed.entries = {};
    parsed.version = 1;
    return parsed;
  } catch (e) {
    return { version: 1, entries: {} };
  }
}

function saveFreeUrlCache(cache) {
  try {
    var entries = cache.entries || {};
    var keys = Object.keys(entries);
    if (keys.length > FREE_URL_CACHE_MAX_ENTRIES) {
      keys.sort(function (a, b) { return (entries[b].ts || 0) - (entries[a].ts || 0); });
      var trimmed = {};
      for (var i = 0; i < FREE_URL_CACHE_MAX_ENTRIES; i++) trimmed[keys[i]] = entries[keys[i]];
      cache.entries = trimmed;
    }
    localStorage.setItem(FREE_URL_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch (e) {}
}

function freeUrlCacheKey(platform, id, quality) {
  return [platform || 'free', String(id || ''), quality || 'hires'].join('::');
}

// 播放链路查询：命中未过期 URL 则直接返回（结构与 /api/free/song/url 响应兼容，可直接当播放 data 用）
function getCachedFreeUrl(platform, id, quality) {
  try {
    if (!platform || !id) return null;
    var cache = loadFreeUrlCache();
    var key = freeUrlCacheKey(platform, id, quality);
    var entry = cache.entries[key];
    if (!entry || !entry.url) return null;
    if (Date.now() - (entry.ts || 0) > FREE_URL_CACHE_TTL_MS) {
      delete cache.entries[key];
      saveFreeUrlCache(cache);
      return null;
    }
    return {
      url: entry.url,
      source: entry.source || '',
      quality: entry.quality || quality || 'hires',
      provider: 'free',
    };
  } catch (e) {
    return null;
  }
}

function setCachedFreeUrl(platform, id, quality, data) {
  try {
    if (!platform || !id || !data || !data.url) return false;
    var cache = loadFreeUrlCache();
    cache.entries[freeUrlCacheKey(platform, id, quality)] = {
      url: data.url,
      source: data.source || '',
      quality: data.quality || quality || 'hires',
      ts: Date.now(),
    };
    saveFreeUrlCache(cache);
    return true;
  } catch (e) {
    return false;
  }
}

// 播放失败 / 超 TTL 重取前，先清除旧缓存再强制走网络
function invalidateFreeUrl(platform, id, quality) {
  try {
    if (!platform || !id) return;
    var cache = loadFreeUrlCache();
    delete cache.entries[freeUrlCacheKey(platform, id, quality)];
    saveFreeUrlCache(cache);
  } catch (e) {}
}

function freeUrlPrefetchQuality() {
  if (typeof getProviderPlaybackQuality === 'function') {
    return getProviderPlaybackQuality('free') || 'hires';
  }
  return 'hires';
}

// 入队：默认仅当无未过期缓存且未在队列中才加入；force=true 时强制刷新（保鲜检查用，忽略已有缓存）
function enqueueFreeUrlPrefetch(platform, id, name, artist, force) {
  if (!platform || !id) return;
  var quality = freeUrlPrefetchQuality();
  if (!force && getCachedFreeUrl(platform, id, quality)) return;
  var st = freeSourcePrefetchState;
  var key = freeUrlCacheKey(platform, id, quality);
  for (var i = 0; i < st.urlQueue.length; i++) {
    if (st.urlQueue[i].key === key) return;
  }
  if (st.urlPrefetchedThisRun >= FREE_URL_PREFETCH_MAX_PER_RUN) return;
  st.urlQueue.push({
    key: key,
    platform: platform,
    id: id,
    name: name || '',
    artist: artist || '',
    quality: quality,
    retryCount: 0,
  });
  if (!st.urlFetching) {
    st.urlFetching = true;
    setTimeout(freeUrlPrefetchWorkerStep, 80);
  }
}

// 并发限速预取 worker：单次调度拉满并发额度，任务落定后递归调度
function freeUrlPrefetchWorkerStep() {
  var st = freeSourcePrefetchState;
  if (!st.urlQueue.length) {
    st.urlFetching = false;
    return;
  }
  while (
    st.urlInFlight < FREE_URL_PREFETCH_MAX_CONCURRENCY &&
    st.urlQueue.length &&
    st.urlPrefetchedThisRun < FREE_URL_PREFETCH_MAX_PER_RUN
  ) {
    var task = st.urlQueue.shift();
    st.urlInFlight += 1;
    st.urlPrefetchedThisRun += 1;
    fetchFreeUrlAndCache(task).then(freeUrlPrefetchSettled, freeUrlPrefetchSettled);
  }
}

function freeUrlPrefetchSettled() {
  var st = freeSourcePrefetchState;
  st.urlInFlight = Math.max(0, st.urlInFlight - 1);
  if (st.urlQueue.length) {
    setTimeout(freeUrlPrefetchWorkerStep, FREE_URL_PREFETCH_GAP_MS);
  } else if (st.urlInFlight === 0) {
    st.urlFetching = false;
  }
}

function fetchFreeUrlAndCache(task) {
  var url = '/api/free/song/url?platform=' + encodeURIComponent(task.platform) +
    '&id=' + encodeURIComponent(task.id) +
    '&name=' + encodeURIComponent(task.name || '') +
    '&artist=' + encodeURIComponent(task.artist || '') +
    '&quality=' + encodeURIComponent(task.quality);
  return apiJson(url, { timeoutMs: 15000 }).then(function (data) {
    if (data && data.url) {
      setCachedFreeUrl(task.platform, task.id, task.quality, data);
      return true;
    }
    reenqueueFreeUrlPrefetch(task);
    return false;
  }, function () {
    reenqueueFreeUrlPrefetch(task);
    return false;
  });
}

// 预取失败重新入队（带重试计数，最多 3 次），不直接丢弃；重试间隔用 RETRY_GAP 限速
function reenqueueFreeUrlPrefetch(task) {
  if (!task || (task.retryCount || 0) >= 3) return;
  var st = freeSourcePrefetchState;
  var key = task.key || freeUrlCacheKey(task.platform, task.id, task.quality);
  for (var i = 0; i < st.urlQueue.length; i++) {
    if (st.urlQueue[i].key === key) return;
  }
  st.urlQueue.push({
    key: key,
    platform: task.platform,
    id: task.id,
    name: task.name || '',
    artist: task.artist || '',
    quality: task.quality,
    retryCount: (task.retryCount || 0) + 1,
  });
  if (!st.urlFetching && st.urlQueue.length) {
    st.urlFetching = true;
    setTimeout(freeUrlPrefetchWorkerStep, FREE_URL_PREFETCH_RETRY_GAP_MS);
  }
}

// 保鲜刷新：遍历 URL 缓存，对剩余 TTL<30% 或已过期的条目强制重新入队预取，让缓存永远新鲜。
// 同时遍历 ID 映射，对尚无 URL 缓存条目的映射批量入队预取，保证启动后播放命中率（消除现场取 URL 延迟）。
function refreshStaleFreeUrlCache() {
  var st = freeSourcePrefetchState;
  st.urlPrefetchedThisRun = 0; // 新一轮预取，重置单轮计数，让多轮 tick 逐步消化全量队列
  var cache = loadFreeUrlCache();
  var entries = cache.entries || {};
  var now = Date.now();
  var keys = Object.keys(entries);
  var refreshed = 0;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var entry = entries[key];
    if (!entry || !entry.url) continue;
    var age = now - (entry.ts || 0);
    if (age < FREE_URL_CACHE_TTL_MS * 0.7) continue; // 剩余 TTL >= 30%，仍新鲜，跳过
    var sep = key.indexOf('::');
    if (sep <= 0) continue;
    var platform = key.substring(0, sep);
    var rest = key.substring(sep + 2);
    var sep2 = rest.indexOf('::');
    var id = sep2 > 0 ? rest.substring(0, sep2) : rest;
    var quality = sep2 > 0 ? rest.substring(sep2 + 2) : freeUrlPrefetchQuality();
    enqueueFreeUrlPrefetch(platform, id, '', '', true);
    refreshed++;
  }
  // 对已有 ID 映射批量补预取 URL：无缓存条目（或已过期）的映射入队，播放时命中即 0 等待
  var idMap = loadFreeIdMap();
  var idEntries = idMap.entries || {};
  var idKeys = Object.keys(idEntries);
  for (var j = 0; j < idKeys.length; j++) {
    var e = idEntries[idKeys[j]];
    if (!e || !e.fid || !e.fp) continue;
    if (now - (e.ts || 0) > FREE_ID_MAP_TTL_MS) continue;
    enqueueFreeUrlPrefetch(e.fp, e.fid, e.name, e.artist, false);
  }
  return refreshed;
}

function freeSourcePrefetchShouldRun() {
  return typeof hasAnyPlatformLogin === 'function' && hasAnyPlatformLogin();
}

function scheduleFreeSourcePrefetchTick() {
  if (freeSourcePrefetchState.tickTimer) clearTimeout(freeSourcePrefetchState.tickTimer);
  freeSourcePrefetchState.tickTimer = setTimeout(freeSourcePrefetchTick, FREE_SOURCE_PREFETCH_TICK_MS);
}

function freeSourcePrefetchTick() {
  var loggedIn = freeSourcePrefetchShouldRun();
  if (loggedIn) {
    // 保鲜刷新：每次 tick 检查 URL 缓存，对剩余 TTL<30% 或已过期的条目重新入队预取
    refreshStaleFreeUrlCache();
  }
  if (loggedIn && !freeSourcePrefetchState.lastLoginState) {
    freeSourcePrefetchState.lastLoginState = true;
    // 登录态刚恢复：先确保歌单就绪（userPlaylists 为空时主动拉取并轮询等待），再全量扫描
    ensureFreeSourcePrefetchPlaylists().then(function (playlists) {
      startFreeSourcePrefetch('full', playlists);
    });
  } else if (!loggedIn) {
    freeSourcePrefetchState.lastLoginState = false;
  } else {
    var playlistsReady = typeof userPlaylists !== 'undefined' && Array.isArray(userPlaylists) && userPlaylists.length;
    if (!playlistsReady) {
      // 歌单仍未就绪（启动时未登录 / 拉取超时 / 从未打开歌单面板）：主动补拉并触发全量扫描，tick 兜底
      ensureFreeSourcePrefetchPlaylists().then(function (playlists) {
        if (playlists && playlists.length) startFreeSourcePrefetch('full', playlists);
      });
    } else {
      var stale = Date.now() - freeSourcePrefetchState.lastScanAt > FREE_SOURCE_PREFETCH_RESIGNATURE_MS;
      if (stale && !freeSourcePrefetchState.running) {
        var changed = computeFreeSourcePrefetchDiff();
        if (changed.length) {
          startFreeSourcePrefetch('incremental', changed);
        } else {
          freeSourcePrefetchState.lastScanAt = Date.now();
        }
      }
    }
  }
  scheduleFreeSourcePrefetchTick();
}

// 确保 userPlaylists 就绪：为空时主动调 refreshUserPlaylists(true) 拉取，并轮询等待
// （间隔 FREE_SOURCE_PREFETCH_PLAYLIST_WAIT_MS，最多 FREE_SOURCE_PREFETCH_PLAYLIST_WAIT_MAX 次），
// 超时返回当前 userPlaylists（可能仍为空，交给 tick 兜底重试）。
function ensureFreeSourcePrefetchPlaylists() {
  if (typeof userPlaylists !== 'undefined' && Array.isArray(userPlaylists) && userPlaylists.length) {
    return Promise.resolve(userPlaylists);
  }
  if (!freeSourcePrefetchState.playlistEnsureRunning) {
    freeSourcePrefetchState.playlistEnsureRunning = true;
    if (typeof refreshUserPlaylists === 'function') {
      try { refreshUserPlaylists(true); } catch (e) { console.warn('[FreeSourcePrefetch] refreshUserPlaylists error', e); }
    }
  }
  return waitForFreeSourcePrefetchPlaylists().then(function (pls) {
    freeSourcePrefetchState.playlistEnsureRunning = false;
    return pls;
  });
}

function waitForFreeSourcePrefetchPlaylists() {
  return new Promise(function (resolve) {
    var waited = 0;
    var timer = setInterval(function () {
      waited += 1;
      if (typeof userPlaylists !== 'undefined' && Array.isArray(userPlaylists) && userPlaylists.length) {
        clearInterval(timer);
        resolve(userPlaylists);
      } else if (waited >= FREE_SOURCE_PREFETCH_PLAYLIST_WAIT_MAX) {
        clearInterval(timer);
        resolve(userPlaylists || []);
      }
    }, FREE_SOURCE_PREFETCH_PLAYLIST_WAIT_MS);
  });
}

function freeSourcePrefetchPlaylistSignature(pl) {
  return [
    pl.trackCount,
    pl.playCount,
    pl.updateTime,
    pl.updatedAt,
    pl.subscribedCount,
    pl.creator,
  ].map(function (v) { return String(v == null ? '' : v); }).join('|');
}

function computeFreeSourcePrefetchDiff() {
  if (typeof userPlaylists === 'undefined' || !Array.isArray(userPlaylists)) return [];
  var changed = [];
  var seen = Object.create(null);
  for (var i = 0; i < userPlaylists.length; i++) {
    var pl = userPlaylists[i];
    if (!pl || !pl.id) continue;
    var provider = normalizePlaylistProvider(pl.provider || pl.source || 'netease');
    if (provider === 'spotify') continue;
    var sigKey = provider + '::' + pl.id;
    var sig = freeSourcePrefetchPlaylistSignature(pl);
    if (freeSourcePrefetchState.playlistSignatures[sigKey] !== sig && !seen[sigKey]) {
      seen[sigKey] = true;
      changed.push({ provider: provider, id: pl.id, name: pl.name, signature: sig });
    }
  }
  return changed;
}

function startFreeSourcePrefetch(mode, playlists) {
  if (freeSourcePrefetchState.running) {
    freeSourcePrefetchState.pendingRescan = true;
    return;
  }
  var source = playlists || [];
  if (mode === 'full' && typeof userPlaylists !== 'undefined' && Array.isArray(userPlaylists)) {
    source = userPlaylists.slice();
  }
  var queue = [];
  for (var i = 0; i < source.length; i++) {
    var pl = source[i];
    if (!pl || !pl.id) continue;
    var provider = normalizePlaylistProvider(pl.provider || pl.source || 'netease');
    if (provider === 'spotify') continue;
    queue.push({ provider: provider, id: pl.id, name: pl.name });
  }
  if (!queue.length) return;
  freeSourcePrefetchState.running = true;
  freeSourcePrefetchState.scanQueue = queue;
  freeSourcePrefetchState.scanIndex = 0;
  freeSourcePrefetchState.searchQueue = [];
  freeSourcePrefetchState.urlPrefetchedThisRun = 0;
  setTimeout(freeSourcePrefetchStep, 50);
}

function freeSourcePrefetchStep() {
  if (!freeSourcePrefetchState.running) return;
  var st = freeSourcePrefetchState;
  if (st.scanIndex >= st.scanQueue.length) {
    st.running = false;
    st.lastScanAt = Date.now();
    if (st.pendingRescan) {
      st.pendingRescan = false;
      startFreeSourcePrefetch('incremental', computeFreeSourcePrefetchDiff());
    }
    return;
  }
  var pl = st.scanQueue[st.scanIndex];
  st.scanIndex += 1;
  fetchPlaylistSongsForFreeSourcePrefetch(pl).then(function (result) {
    if (result && result.songs && result.songs.length) {
      enqueueFreeSourceIdSearch(pl.provider, result.songs);
    }
    var sigKey = pl.provider + '::' + pl.id;
    freeSourcePrefetchState.playlistSignatures[sigKey] = freeSourcePrefetchPlaylistSignature(pl);
    setTimeout(freeSourcePrefetchStep, FREE_SOURCE_PREFETCH_PLAYLIST_GAP_MS);
  }).catch(function () {
    setTimeout(freeSourcePrefetchStep, FREE_SOURCE_PREFETCH_PLAYLIST_GAP_MS);
  });
}

async function fetchPlaylistSongsForFreeSourcePrefetch(pl) {
  var songs = [];
  var offset = 0;
  var limit = 200;
  var maxPages = 8;
  for (var page = 0; page < maxPages; page++) {
    try {
      var endpoint = playlistTracksEndpoint(pl.provider, pl.id, { limit: limit, offset: offset });
      var r = await apiJson(endpoint, { timeoutMs: 15000 });
      var tracks = (r && r.tracks) || [];
      if (!tracks.length) break;
      for (var i = 0; i < tracks.length; i++) {
        var song = tracks[i];
        if (!song) continue;
        if (typeof songRequiresVip === 'function' && songRequiresVip(song)) songs.push(song);
      }
      if (!(r && r.hasMore) || tracks.length < limit) break;
      offset = Number(r && r.nextOffset) || (offset + tracks.length);
    } catch (e) {
      break;
    }
    if (page < maxPages - 1) {
      await new Promise(function (resolve) { setTimeout(resolve, FREE_SOURCE_PREFETCH_PAGE_GAP_MS); });
    }
  }
  return { songs: songs };
}

function enqueueFreeSourceIdSearch(provider, songs) {
  var st = freeSourcePrefetchState;
  var map = loadFreeIdMap();
  var budget = Math.max(0, FREE_SOURCE_PREFETCH_MAX_PER_RUN - st.searchQueue.length);
  for (var i = 0; i < songs.length && i < budget; i++) {
    var song = songs[i];
    if (!song) continue;
    var key = freeIdMapKey(song);
    var existing = map.entries[key];
    if (existing && existing.fid && Date.now() - (existing.ts || 0) < FREE_ID_MAP_TTL_MS) continue;
    var queued = false;
    for (var j = 0; j < st.searchQueue.length; j++) {
      if (st.searchQueue[j].key === key) { queued = true; break; }
    }
    if (queued) continue;
    st.searchQueue.push({ key: key, provider: provider, song: song });
  }
  if (st.searchQueue.length && !st.searching) {
    st.searching = true;
    setTimeout(freeSourceIdSearchWorkerStep, 50);
  }
}

function freeSourceIdSearchWorkerStep() {
  var st = freeSourcePrefetchState;
  if (!st.searchQueue.length) {
    st.searching = false;
    return;
  }
  var task = st.searchQueue.shift();
  var query = [(task.song.name || task.song.title || ''), (task.song.artist || '')].filter(Boolean).join(' ').trim();
  if (!query) {
    setTimeout(freeSourceIdSearchWorkerStep, 20);
    return;
  }
  var platforms = ['kw', 'mg'];
  searchFreeSourceIdPlatform(task, query, platforms, 0).then(function (done) {
    setTimeout(freeSourceIdSearchWorkerStep, done ? FREE_SOURCE_PREFETCH_SEARCH_GAP_MS : 80);
  }).catch(function () {
    setTimeout(freeSourceIdSearchWorkerStep, FREE_SOURCE_PREFETCH_SEARCH_GAP_MS);
  });
}

function searchFreeSourceIdPlatform(task, query, platforms, pi) {
  if (pi >= platforms.length) return Promise.resolve(false);
  var plat = platforms[pi];
  var url = plat === 'kw'
    ? '/api/free/search/kuwo?keyword=' + encodeURIComponent(query) + '&limit=6'
    : '/api/free/search/migu?keyword=' + encodeURIComponent(query) + '&limit=6';
  return apiJson(url, { timeoutMs: 12000 }).then(function (data) {
    var list = data && (data.list || data.songs || data.result || []);
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var cand = list[i];
        if (!cand) continue;
        // 二次防御：候选原始名称含衍生版本标识（Live/Remix/翻唱/伴奏等）则跳过，避免错配
        var _candRaw = String(((cand && cand.name) || '') + ' ' + ((cand && cand.artist) || '') + ' ' + ((cand && cand.album) || '')).toLowerCase();
        if (typeof searchLooksLikeDerivative === 'function' && searchLooksLikeDerivative(_candRaw)) continue;
        if (typeof isSameTitleArtist === 'function' && isSameTitleArtist(task.song, cand)) {
          // mg 平台搜索实际走 netease 源：若候选 id 与原曲 id 相同则换源无效，跳过
          if (plat === 'mg') {
            var _origId = String(task.song.id || task.song.mid || task.song.songmid || '');
            var _candId = String(cand.id || cand.songmid || cand.mid || '');
            if (_origId && _candId && _origId === _candId) continue;
          }
          var entry = buildFreeSourceIdMapEntry(plat, cand);
          if (entry) {
            var map = loadFreeIdMap();
            map.entries[task.key] = entry;
            saveFreeIdMap(map);
            // 命中 ID 映射后，顺手并发限速预取播放 URL 并缓存，消除播放时约 2.8s 实时解析延迟
            enqueueFreeUrlPrefetch(entry.fp, entry.fid, entry.name, entry.artist);
            return Promise.resolve(true);
          }
        }
      }
    }
    if (pi + 1 < platforms.length) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(searchFreeSourceIdPlatform(task, query, platforms, pi + 1));
        }, FREE_SOURCE_PREFETCH_PLATFORM_GAP_MS);
      });
    }
    return Promise.resolve(false);
  }).catch(function () {
    if (pi + 1 < platforms.length) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(searchFreeSourceIdPlatform(task, query, platforms, pi + 1));
        }, FREE_SOURCE_PREFETCH_PLATFORM_GAP_MS);
      });
    }
    return Promise.resolve(false);
  });
}

function buildFreeSourceIdMapEntry(plat, cand) {
  var fid = '';
  if (plat === 'kw' || plat === 'kuwo') {
    fid = cand.songmid || cand.mid || cand.id || '';
  } else {
    fid = cand.id || cand.songmid || cand.mid || '';
  }
  if (!fid) return null;
  return {
    fp: (plat === 'kuwo' ? 'kw' : (plat === 'migu' ? 'mg' : plat)),
    fid: String(fid),
    name: cand.name || '',
    artist: cand.artist || '',
    ts: Date.now(),
  };
}

// 启动：延迟等待登录状态恢复，再进入轮询；启动即恢复——立即执行保鲜检查并触发全量扫描
setTimeout(function () {
  freeSourcePrefetchState.lastLoginState = freeSourcePrefetchShouldRun();
  if (freeSourcePrefetchState.lastLoginState) {
    refreshStaleFreeUrlCache();
    // 启动时 userPlaylists 可能尚未就绪（异步拉取未完成 / 从未打开歌单面板），
    // 先确保歌单就绪再全量扫描，避免 startFreeSourcePrefetch 因空歌单静默 return。
    ensureFreeSourcePrefetchPlaylists().then(function (playlists) {
      startFreeSourcePrefetch('full', playlists);
    });
  }
  scheduleFreeSourcePrefetchTick();
}, FREE_SOURCE_PREFETCH_INIT_DELAY_MS);
