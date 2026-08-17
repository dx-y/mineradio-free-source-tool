// ==================== Mineradio 免费音源优化插件 v1.0 ====================
// 插件名：free-source-official-playable
// 作用：防止"官方可播却被误换三方源"（如元数据带 vipRequired 但官方 URL 实测可播的歌）。
// 原理：包装官方 songRequiresVip 函数——官方可播性缓存命中且官方可直接播放时返回 false，
//       使官方换源决策与预扫描收集都跳过该歌，保持官方源。
// 加载：在 index-loader.js 的 modulePaths 数组末尾追加本文件路径。
// 卸载：从 index-loader.js 移除本文件路径即可，官方文件零改动。
(function () {
  'use strict';

  var OFFICIAL_PLAYABLE_CACHE_KEY = 'mr_official_playable_cache_v1';
  var OFFICIAL_PLAYABLE_CACHE_TTL_MS = 24 * 3600 * 1000; // 24h
  var OFFICIAL_PLAYABLE_PROBE_MAX_CONCURRENCY = 2;
  var OFFICIAL_PLAYABLE_PROBE_GAP_MS = 500;

  var probeState = { queue: [], inFlight: 0, running: false };

  function loadCache() {
    try {
      var raw = localStorage.getItem(OFFICIAL_PLAYABLE_CACHE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed;
      }
    } catch (e) {}
    return { version: 1, entries: {} };
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(OFFICIAL_PLAYABLE_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
  }

  function cacheKey(song) {
    var provider = (typeof songProviderKey === 'function' ? songProviderKey(song) : (song.provider || 'netease'));
    var id = song && (song.id || song.mid || song.songmid || song.mediaMid || song.media_mid || song.hash || '');
    return (provider || 'netease') + '::' + id;
  }

  function getCached(song) {
    try {
      if (!song) return null;
      var cache = loadCache();
      var entry = cache.entries[cacheKey(song)];
      if (entry && Date.now() - (entry.ts || 0) < OFFICIAL_PLAYABLE_CACHE_TTL_MS) {
        return { playable: !!entry.playable, trial: !!entry.trial };
      }
    } catch (e) {}
    return null;
  }

  function setCached(song, playable, trial) {
    try {
      if (!song) return;
      var cache = loadCache();
      cache.entries[cacheKey(song)] = { playable: !!playable, trial: !!trial, ts: Date.now() };
      saveCache(cache);
    } catch (e) {}
  }

  function resolveOfficialPlayability(song) {
    var cached = getCached(song);
    if (cached) return Promise.resolve(cached);
    var id = song && (song.id || song.mid || song.songmid || song.mediaMid || song.media_mid || song.hash || '');
    if (!id) return Promise.resolve(null);
    var url = '/api/song/url?id=' + encodeURIComponent(id);
    var p;
    if (typeof apiJson === 'function') {
      p = apiJson(url, { timeoutMs: 8000 });
    } else {
      p = fetch(url, { method: 'GET' }).then(function (r) { return r.json(); });
    }
    return p.then(function (data) {
      var playable = !!(data && data.playable);
      var trial = !!(data && data.trial);
      setCached(song, playable, trial);
      return { playable: playable, trial: trial };
    }).catch(function () {
      return null;
    });
  }

  function enqueueProbe(song) {
    if (!song) return;
    var key = cacheKey(song);
    for (var i = 0; i < probeState.queue.length; i++) {
      if (probeState.queue[i].key === key) return;
    }
    probeState.queue.push({ key: key, song: song });
    if (!probeState.running) {
      probeState.running = true;
      setTimeout(probeWorkerStep, 50);
    }
  }

  function probeWorkerStep() {
    if (!probeState.queue.length) {
      probeState.running = false;
      return;
    }
    while (probeState.inFlight < OFFICIAL_PLAYABLE_PROBE_MAX_CONCURRENCY && probeState.queue.length) {
      var task = probeState.queue.shift();
      probeState.inFlight += 1;
      resolveOfficialPlayability(task.song).then(function (result) {
        probeState.inFlight = Math.max(0, probeState.inFlight - 1);
        if (result && result.playable && !result.trial) {
          // 官方可播：若预扫描已误建 ID 映射，立即剔除，避免播放时命中映射误换源
          try {
            if (typeof loadFreeIdMap === 'function' && typeof freeIdMapKey === 'function' && typeof saveFreeIdMap === 'function') {
              var map = loadFreeIdMap();
              var mk = freeIdMapKey(task.song);
              if (map && map.entries && map.entries[mk]) {
                delete map.entries[mk];
                saveFreeIdMap(map);
              }
            }
          } catch (e) {}
        }
        if (probeState.queue.length) {
          setTimeout(probeWorkerStep, OFFICIAL_PLAYABLE_PROBE_GAP_MS);
        } else if (probeState.inFlight === 0) {
          probeState.running = false;
        }
      }, function () {
        probeState.inFlight = Math.max(0, probeState.inFlight - 1);
        if (probeState.queue.length) {
          setTimeout(probeWorkerStep, OFFICIAL_PLAYABLE_PROBE_GAP_MS);
        } else if (probeState.inFlight === 0) {
          probeState.running = false;
        }
      });
    }
  }

  // 包装官方 songRequiresVip：官方可播（缓存命中且 playable && !trial）→ 返回 false
  var _origSongRequiresVip = (typeof songRequiresVip === 'function') ? songRequiresVip : null;
  function patchedSongRequiresVip(song) {
    var base = _origSongRequiresVip ? _origSongRequiresVip(song) : false;
    if (base) {
      var cached = getCached(song);
      if (cached) {
        if (cached.playable && !cached.trial) return false;
      } else {
        enqueueProbe(song);
      }
    }
    return base;
  }
  window.songRequiresVip = patchedSongRequiresVip;
})();
