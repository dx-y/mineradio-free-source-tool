#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mineradio 优化工具 v4.1
WebView2 渲染引擎 · 界面 100% 复刻 Mineradio 原版玻璃拟态
（深色渐变 + 点阵纹理 + 毛玻璃卡片 + 青绿发光按钮）

v4.1 增强：
  ① 窗口交互做全：标题栏 JS 拖拽 + 四边四角缩放手柄（fix_point 缩放）
  ② 界面图标补齐：标题栏 Logo / 状态指示点 / 按钮图标（内联 SVG）
  ③ 使用说明卡片修复：展开内容超高时内部滚动，不再整体显示不全
  ④ 界面文案低调化：聚焦软件优化介绍，敏感音源相关描述一笔带过

优化内容（相对官方原版 v2.1.0）：
  ① 官方可播性实测插件  plugin-free-source-official-playable.js
  ② 播放源扩展          free-source-api.js + free-source-servers.json
  ③ 扩展音源接入        lx-runner.js + lx-source-cache.js
  ④ 预扫描/URL 预取     06-free-source-prefetch.js
  ⑤ server.js / 11-provider-fallback.js / index-loader.js 注入增强

部署策略：文件级替换 + 备份恢复。安装前自动备份，卸载一键恢复官方原样。
"""
import os
import sys
import shutil
import subprocess
import time
import webview
from webview.window import FixPoint

DEFAULT_MINERADIO_DIR = r"D:\VIAP软件迁移\应用\Mineradio"

# ============ 相对 resources/app 的路径定义 ============
# 官方可播插件钩子
PLUGIN_NAME = "plugin-free-source-official-playable.js"
PLUGIN_REL = os.path.join("public", "js", "modules", "08-account", PLUGIN_NAME)
INDEX_LOADER_REL = os.path.join("public", "js", "index-loader.js")
HOOK_PATH = "js/modules/08-account/" + PLUGIN_NAME
ANCHOR = "'js/modules/11-main-loop.js',"

# 扩展组件注入文件（相对 resources/app）
THIRD_PARTY_FILES = [
    "free-source-api.js",
    "free-source-servers.json",
    "lx-runner.js",
    "lx-source-cache.js",
    os.path.join("public", "js", "modules", "08-account", "06-free-source-prefetch.js"),
    PLUGIN_REL,
]

# 需要文件级替换的文件（相对 resources/app）
REPLACE_FILES = [
    "server.js",
    os.path.join("public", "js", "modules", "05-playback", "11-provider-fallback.js"),
    INDEX_LOADER_REL,
]

# 注入点特征标记（用于检测）
SERVER_MARK = "free-source-api"
FALLBACK_MARK = "FREE_SOURCE_CACHE_KEY"
PREFETCH_HOOK = "js/modules/08-account/06-free-source-prefetch.js"

# 备份目录（相对 resources/app）
BACKUP_DIR_NAME = ".mr-tool-backup"


def resource_path(rel):
    """PyInstaller 打包后资源路径（资源统一放在 resources 目录下）"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "resources", rel)


def app_dir_of(mineradio_dir):
    return os.path.join(mineradio_dir, "resources", "app")


def find_mineradio_dir():
    """自动检测 Mineradio 安装位置，返回所有含 Mineradio.exe 的有效目录列表"""
    ps = r'''
$sh = New-Object -ComObject WScript.Shell
$dirs = @()
$dirs += "D:\VIAP软件迁移\应用\Mineradio"
$dirs += "D:\Mineradio"
foreach($p in @("$env:USERPROFILE\Desktop\Mineradio.lnk", "$env:PUBLIC\Desktop\Mineradio.lnk")){
  if(Test-Path $p){ try{ $l=$sh.CreateShortcut($p); if($l.TargetPath){ $dirs += (Split-Path $l.TargetPath -Parent) } }catch{} }
}
$regPaths = @(
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach($rp in $regPaths){
  Get-ItemProperty $rp -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match "Mineradio" -and $_.InstallLocation } |
    ForEach-Object { $dirs += $_.InstallLocation }
}
$dirs | Where-Object { $_ -and (Test-Path (Join-Path $_ "Mineradio.exe")) } | Select-Object -Unique
'''
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, text=True, timeout=15,
        )
        return [l.strip() for l in out.stdout.splitlines() if l.strip()]
    except Exception:
        return []


def is_app_running():
    """检测 Mineradio 进程是否在运行"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Mineradio.exe"],
            capture_output=True, text=True, timeout=10,
        )
        return "Mineradio.exe" in out.stdout
    except Exception:
        return False


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def detect_status(mineradio_dir):
    """检测软件安装状态 + 完整优化状态"""
    exe = os.path.join(mineradio_dir, "Mineradio.exe")
    app_installed = os.path.isfile(exe)
    app_running = is_app_running() if app_installed else False

    if not app_installed:
        return {
            "status": "not_found", "text": "未检测到 Mineradio 软件",
            "app_installed": False, "app_running": False,
            "plugin": "unknown", "third_party": "unknown",
        }

    app_dir = app_dir_of(mineradio_dir)
    if not os.path.isdir(app_dir):
        return {
            "status": "not_found", "text": "Mineradio 已安装，但缺少 resources/app",
            "app_installed": True, "app_running": app_running,
            "plugin": "unknown", "third_party": "unknown",
        }

    # ---- 官方可播插件检测 ----
    plugin_dst = os.path.join(app_dir, PLUGIN_REL)
    index_loader = os.path.join(app_dir, INDEX_LOADER_REL)
    plugin_file = os.path.isfile(plugin_dst)
    hooked = HOOK_PATH in _read_text(index_loader)
    plugin_ok = plugin_file and hooked

    # ---- 扩展组件检测 ----
    tp_files_ok = all(os.path.isfile(os.path.join(app_dir, f)) for f in THIRD_PARTY_FILES)
    server_ok = SERVER_MARK in _read_text(os.path.join(app_dir, "server.js"))
    fallback_ok = FALLBACK_MARK in _read_text(os.path.join(app_dir, REPLACE_FILES[1]))
    prefetch_ok = PREFETCH_HOOK in _read_text(index_loader)
    third_party_ok = tp_files_ok and server_ok and fallback_ok and prefetch_ok

    # ---- 综合判定 ----
    if plugin_ok and third_party_ok:
        status, text = "installed", "优化已完成 · 完整状态"
    elif plugin_ok or third_party_ok:
        status, text = "partial", "部分优化（组件缺失）"
    else:
        status, text = "not_installed", "未优化（官方原版状态）"

    return {
        "status": status, "text": text,
        "app_installed": True, "app_running": app_running,
        "plugin": "installed" if plugin_ok else ("partial" if (plugin_file or hooked) else "not_installed"),
        "third_party": "installed" if third_party_ok else ("partial" if (tp_files_ok or server_ok or fallback_ok or prefetch_ok) else "not_installed"),
    }


def detect_third_party(mineradio_dir):
    """检测优化组件部署明细（供 UI 展示）"""
    app_dir = app_dir_of(mineradio_dir)
    present = [f for f in THIRD_PARTY_FILES if os.path.isfile(os.path.join(app_dir, f))]
    return {
        "deployed": len(present) > 0,
        "files": present,
        "text": "已部署（%d/%d 个文件）" % (len(present), len(THIRD_PARTY_FILES)) if present else "未部署",
    }


def _backup_current(app_dir, logs):
    """备份当前 3 个待替换文件到备份目录，返回备份目录路径"""
    backup_dir = os.path.join(app_dir, BACKUP_DIR_NAME)
    os.makedirs(backup_dir, exist_ok=True)
    for rel in REPLACE_FILES:
        src = os.path.join(app_dir, rel)
        if os.path.isfile(src):
            dst = os.path.join(backup_dir, os.path.basename(rel))
            shutil.copy2(src, dst)
            logs.append({"msg": "已备份 " + os.path.basename(rel) + " -> " + dst, "cls": "ok"})
    return backup_dir


def _install(mineradio_dir):
    """一键安装完整优化，返回 (ok, logs)"""
    logs = []
    app_dir = app_dir_of(mineradio_dir)
    if not os.path.isdir(app_dir):
        logs.append({"msg": "错误：未找到 resources/app，请确认 Mineradio 路径", "cls": "err"})
        return False, logs

    # 1. 备份当前文件
    _backup_current(app_dir, logs)

    # 2. 复制扩展组件注入文件
    for rel in THIRD_PARTY_FILES:
        src = resource_path(os.path.join("files", os.path.basename(rel)))
        dst = os.path.join(app_dir, rel)
        if not os.path.isfile(src):
            logs.append({"msg": "错误：资源缺失 " + os.path.basename(rel), "cls": "err"})
            return False, logs
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        logs.append({"msg": "已部署 " + rel, "cls": "ok"})

    # 3. 文件级替换（server.js / 11-provider-fallback.js / index-loader.js）
    for rel in REPLACE_FILES:
        src = resource_path(os.path.join("injected", os.path.basename(rel)))
        dst = os.path.join(app_dir, rel)
        if not os.path.isfile(src):
            logs.append({"msg": "错误：注入版资源缺失 " + os.path.basename(rel), "cls": "err"})
            return False, logs
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        logs.append({"msg": "已注入 " + rel, "cls": "ok"})

    logs.append({"msg": "安装完成！请重启 Mineradio 使完整优化生效。", "cls": "ok"})
    return True, logs


def _uninstall(mineradio_dir):
    """一键卸载完整优化（恢复官方原样），返回 (ok, logs)"""
    logs = []
    app_dir = app_dir_of(mineradio_dir)
    if not os.path.isdir(app_dir):
        logs.append({"msg": "错误：未找到 resources/app，请确认 Mineradio 路径", "cls": "err"})
        return False, logs

    backup_dir = os.path.join(app_dir, BACKUP_DIR_NAME)

    # 1. 恢复 3 个被替换文件（优先用备份，否则用官方原版资源）
    for rel in REPLACE_FILES:
        dst = os.path.join(app_dir, rel)
        backup_src = os.path.join(backup_dir, os.path.basename(rel))
        official_src = resource_path(os.path.join("official", os.path.basename(rel)))
        if os.path.isfile(backup_src):
            shutil.copy2(backup_src, dst)
            logs.append({"msg": "已从备份恢复 " + rel, "cls": "ok"})
        elif os.path.isfile(official_src):
            shutil.copy2(official_src, dst)
            logs.append({"msg": "已恢复官方原版 " + rel, "cls": "ok"})
        else:
            logs.append({"msg": "错误：无可用恢复源 " + rel, "cls": "err"})
            return False, logs

    # 2. 删除扩展组件注入文件
    for rel in THIRD_PARTY_FILES:
        dst = os.path.join(app_dir, rel)
        if os.path.isfile(dst):
            os.remove(dst)
            logs.append({"msg": "已删除 " + rel, "cls": "ok"})
        else:
            logs.append({"msg": "未发现 " + rel + "，跳过", "cls": "warn"})

    # 3. 清理备份目录
    if os.path.isdir(backup_dir):
        shutil.rmtree(backup_dir, ignore_errors=True)
        logs.append({"msg": "已清理备份目录", "cls": "ok"})

    logs.append({"msg": "卸载完成！Mineradio 已恢复官方原样。", "cls": "ok"})
    return True, logs


class Api:
    def __init__(self):
        self._window = None

    def set_window(self, w):
        self._window = w

    def minimize(self):
        if self._window:
            self._window.minimize()

    def toggle_maximize(self):
        if self._window:
            if self._window.maximized:
                self._window.restore()
            else:
                self._window.maximize()

    def close(self):
        if self._window:
            self._window.destroy()

    # ===== 窗口拖拽缩放支持（v4.1）=====
    _FIXPOINT_MAP = {
        'nw': FixPoint.EAST | FixPoint.SOUTH,
        'n':  FixPoint.SOUTH,
        'ne': FixPoint.WEST | FixPoint.SOUTH,
        'e':  FixPoint.WEST,
        'se': FixPoint.NORTH | FixPoint.WEST,
        's':  FixPoint.NORTH,
        'sw': FixPoint.EAST | FixPoint.NORTH,
        'w':  FixPoint.EAST,
    }

    def get_window_state(self):
        """返回窗口当前位置/尺寸（逻辑像素，供 JS 拖拽/缩放计算）"""
        try:
            native = getattr(self._window, 'native', None)
            if native is not None:
                scale = getattr(native, '_scale', 1) or 1
                return {
                    "x": int(native.Location.X / scale),
                    "y": int(native.Location.Y / scale),
                    "width": int(native.Width / scale),
                    "height": int(native.Height / scale),
                }
        except Exception:
            pass
        return {"x": 0, "y": 0, "width": 680, "height": 680}

    def move_to(self, x, y):
        if self._window:
            self._window.move(x, y)

    def resize_to(self, width, height, direction):
        """按方向缩放窗口，direction: nw/n/ne/e/se/s/sw/w"""
        if self._window:
            fp = self._FIXPOINT_MAP.get(direction, FixPoint.NORTH | FixPoint.WEST)
            self._window.resize(width, height, fp)

    def get_default_dir(self):
        return DEFAULT_MINERADIO_DIR

    def find_mineradio_dir(self):
        return find_mineradio_dir()

    def detect_status(self, dir_path):
        d = (dir_path or "").strip() or DEFAULT_MINERADIO_DIR
        return detect_status(d)

    def detect_third_party(self, dir_path):
        d = (dir_path or "").strip() or DEFAULT_MINERADIO_DIR
        return detect_third_party(d)

    def browse_dir(self):
        try:
            result = self._window.create_file_dialog(
                webview.FOLDER_DIALOG,
                directory=(self._window and os.path.dirname(DEFAULT_MINERADIO_DIR)) or "D:\\",
            )
            return result if result else []
        except Exception as e:
            return []

    def install(self, dir_path):
        d = (dir_path or "").strip() or DEFAULT_MINERADIO_DIR
        ok, logs = _install(d)
        return {"ok": ok, "logs": logs}

    def uninstall(self, dir_path):
        d = (dir_path or "").strip() or DEFAULT_MINERADIO_DIR
        ok, logs = _uninstall(d)
        return {"ok": ok, "logs": logs}


def _apply_window_icon(window, icon_path):
    """为窗口设置图标（winforms/edgechromium 后端均生效）"""
    try:
        from System.Drawing import Icon
        native = getattr(window, "native", None)
        if native is not None:
            native.Icon = Icon(icon_path)
    except Exception:
        pass


def main():
    api = Api()
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    index_html = os.path.join(base, "ui", "index.html")
    icon_path = os.path.join(base, "assets", "mineradio_tool.ico")
    window = webview.create_window(
        "Mineradio 优化工具",
        url=index_html,
        js_api=api,
        width=680,
        height=680,
        min_size=(620, 600),
        frameless=True,
        easy_drag=False,
        background_color="#08090B",
    )
    api.set_window(window)
    if os.path.exists(icon_path):
        window.events.loaded += lambda: _apply_window_icon(window, icon_path)
        webview.start(icon=icon_path)
    else:
        webview.start()


if __name__ == "__main__":
    main()
