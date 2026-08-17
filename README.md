# Mineradio 免费音源优化工具

> 让 Mineradio 免费听遍全网 · 官方可播性实测 + 免费音源聚合 + LX 音源 + 预扫描预取
> 一键安装 / 一键卸载 · 官方文件零改动 · 完整可回滚

---

## 项目简介

本项目为 [Mineradio](https://github.com/XxHuberrr/Mineradio)（v2.1.0）提供一套**免费音源优化方案**，以**独立插件 + 文件级注入**的形式部署，官方文件零改动、可一键完整回滚。

核心目标：**VIP / 付费歌曲自动切换免费音源播放，同时保证官方可播的歌曲不被误换源**，实现"打开即用、点击即播"的无感体验。

配套提供 **WebView2 玻璃拟态 GUI 工具**（`MineradioTool_v4.exe`），自动检测安装位置与优化状态，一键完成安装 / 卸载。

---

## 优化总览

优化由**两大独立部分**组成，均由 GUI 工具统一管理：

| 部分 | 内容 | 形态 |
|------|------|------|
| ① 官方可播性实测插件 | 防止"官方可播却被误换三方源" | 独立插件文件 + index-loader 钩子 |
| ② 三方音源接入 | 免费音源聚合 + LX 音源 + 预扫描/URL 预取 | 独立文件 + server.js / 11-provider-fallback.js 注入 |

---

## 优化内容详解

### 1. 官方可播性实测插件（plugin-free-source-official-playable.js）

**问题**：部分歌曲元数据带 `vipRequired` 标记，但官方 URL 实测可直接播放（试听/免费）。原版会误判为 VIP 并换到三方源，导致音质下降或播放异常。

**方案**：包装官方 `songRequiresVip` 函数——官方可播性缓存命中且官方可直接播放时返回 `false`，使官方换源决策与预扫描收集都跳过该歌，**保持官方源**。

- 24h 可播性缓存（localStorage 持久化）
- 并发限速探测（最多 2 并发 + 500ms 间隔），不压垮官方接口
- 以官方 URL 解析的 `playable / trial` 实测结果为准，而非元数据标记

### 2. 免费音源聚合（free-source-api.js + free-source-servers.json）

**方案**：服务端新增免费音源 API 模块，多源自动切换 + 健康检查。

- **GD Studio 聚合 API**（主源，netease 播放地址稳定）
- **Kuwo / Migu 搜索 + Netease 跨平台解析**
- **LX Music 服务器兜底**（默认 2 个，可配置）
- 音源服务器列表通过 `free-source-servers.json` 热加载配置，支持增删改
- 失败自动降级 / 拉黑 / 健康检查，保证可用性

### 3. LX 音源接入（lx-runner.js + lx-source-cache.js）

**方案**：在 Node.js VM 沙箱中执行 LX Music v2 源脚本，提供 `search / getMusicUrl / getMusicInfo` 统一接口。

- 内置 6 个音源脚本：LX 官方源、六音、Huibq、野花、ikun、野草
- 平台映射：网易云 / QQ / 酷狗 / 酷我 / 咪咕
- 音源脚本结果本地缓存，减少重复请求

### 4. 预扫描 + URL 预取（06-free-source-prefetch.js）

**方案**：登录后后台静默预扫描，建立"原曲 ID → 免费源平台 + 歌曲 ID"映射，并预取播放 URL。

- 静默拉取歌单（收藏 + 自建），用歌单接口自带的 vip/付费标记筛出需换源的歌
- 分批节流预搜酷我 / 咪咕，建立 ID 映射（仅存 ID，不存签名 URL）
- **URL 预取缓存**（90 分钟 TTL）：预取播放 URL 并本地持久化，**消除 GD Studio 约 2.8s 的实时解析延迟**
- 播放时命中映射直接按免费源 ID 取 URL，跳过现场搜同名曲
- 启动 2s 即恢复预扫描状态，歌单增量补扫，保鲜刷新

### 5. 核心文件注入增强

| 文件 | 注入内容 |
|------|----------|
| `server.js` | 8 个 require 块 + 免费音源搜索 / 配置重载等路由 |
| `11-provider-fallback.js` | `free` provider 分支 + 免费源缓存（7 天 TTL） |
| `index-loader.js` | 2 处钩子：预扫描模块 + 官方可播插件 |

---

## 对比原版提升

| 维度 | 原版 v2.1.0 | 优化后 |
|------|-------------|--------|
| VIP 歌曲 | 需会员，否则无法播放 | 自动切换免费源（酷我/咪咕/LX），免费畅听 |
| 播放延迟 | 换源需实时解析（约 2.8s） | URL 预取缓存，点击即播 |
| 换源决策 | 按元数据标记判断，易误判 | 官方可播性实测，官方可播保持官方源 |
| 音源可用性 | 单一音源，失效即断 | 多源自动切换 + 健康检查 + 兜底 |
| 启动恢复 | 需重新扫描 | 2s 恢复预扫描状态，增量补扫 |
| 可回滚性 | — | 一键卸载恢复官方原样 |

---

## 快速开始

1. 下载官方原版 Mineradio v2.1.0 并安装
2. 运行 `MineradioTool_v4.exe`（自动检测安装位置与优化状态）
3. 点击 **「一键安装」**，自动完成全部优化部署
4. 重启 Mineradio，即达到完整优化状态

> 工具界面 100% 复刻 Mineradio 原版视觉（深色渐变 + 点阵纹理 + 毛玻璃卡片 + 青绿发光按钮），WebView2 渲染。

## 一键卸载

点击 **「一键卸载」**，自动恢复官方原样：

- 用官方原版文件恢复 `server.js` / `11-provider-fallback.js` / `index-loader.js`
- 删除全部注入文件
- 清理备份目录

---

## 技术细节

### 部署策略

- **官方可播插件**：仅向 `index-loader.js` 的 `modulePaths` 追加一行钩子路径，官方文件零改动
- **三方音源**：文件级替换（安装前自动备份到 `.mr-tool-backup/`，卸载优先从备份恢复）

### 文件清单

```
resources/
├── official/     # 官方原版 server.js / 11-provider-fallback.js / index-loader.js
├── injected/     # 注入增强版（对应 3 个文件）
└── files/        # 6 个独立注入文件
    ├── free-source-api.js
    ├── free-source-servers.json
    ├── lx-runner.js
    ├── lx-source-cache.js
    ├── public/js/modules/08-account/06-free-source-prefetch.js
    └── public/js/modules/08-account/plugin-free-source-official-playable.js
```

### 技术栈

- Python 3.11 + pywebview（WebView2 渲染）
- Node.js VM 沙箱（LX 音源脚本执行）
- 本地 localStorage 持久化缓存

---

## 免责声明

本项目仅供技术学习与个人使用。免费音源来自第三方公开接口，请尊重音乐版权，支持正版。使用本项目造成的任何后果由使用者自行承担。
