# Mineradio 免费音源优化插件 - 安装脚本
param(
    [string]$MineradioDir = "D:\VIAP软件迁移\应用\Mineradio"
)

$ErrorActionPreference = "Stop"
$pluginName = "plugin-free-source-official-playable.js"
$pluginSrc = Join-Path $PSScriptRoot "free-source-official-playable.js"
$indexLoader = Join-Path $MineradioDir "resources\app\public\js\index-loader.js"
$pluginDst = Join-Path $MineradioDir "resources\app\public\js\modules\08-account\$pluginName"
$hookPath = "js/modules/08-account/$pluginName"

Write-Host "============================================"
Write-Host " Mineradio 免费音源优化插件 - 安装"
Write-Host "============================================"

# 1. 检测安装路径
if (-not (Test-Path $indexLoader)) {
    Write-Host "[错误] 未找到 Mineradio 安装目录: $MineradioDir" -ForegroundColor Red
    Write-Host "       请检查路径，或修改本脚本的 -MineradioDir 参数后重试。"
    exit 1
}
Write-Host "[OK] 检测到 Mineradio: $MineradioDir"

# 2. 复制插件脚本
if (-not (Test-Path $pluginSrc)) {
    Write-Host "[错误] 未找到插件脚本: $pluginSrc" -ForegroundColor Red
    exit 1
}
Copy-Item -Path $pluginSrc -Destination $pluginDst -Force
Write-Host "[OK] 插件脚本已复制: $pluginDst"

# 3. 注入加载钩子
$content = [System.IO.File]::ReadAllText($indexLoader, [System.Text.Encoding]::UTF8)
if ($content.Contains($hookPath)) {
    Write-Host "[OK] 加载钩子已存在，跳过注入"
} else {
    $anchor = "'js/modules/11-main-loop.js',"
    if (-not $content.Contains($anchor)) {
        Write-Host "[错误] 未找到 modulePaths 锚点，注入失败" -ForegroundColor Red
        exit 1
    }
    $content = $content.Replace($anchor, $anchor + "`r`n    '" + $hookPath + "',")
    [System.IO.File]::WriteAllText($indexLoader, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[OK] 加载钩子已注入 index-loader.js"
}

Write-Host ""
Write-Host "安装完成！请重启 Mineradio 使插件生效。" -ForegroundColor Green
