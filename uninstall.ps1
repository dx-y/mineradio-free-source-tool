# Mineradio 免费音源优化插件 - 卸载脚本
param(
    [string]$MineradioDir = "D:\VIAP软件迁移\应用\Mineradio"
)

$ErrorActionPreference = "Stop"
$pluginName = "plugin-free-source-official-playable.js"
$indexLoader = Join-Path $MineradioDir "resources\app\public\js\index-loader.js"
$pluginDst = Join-Path $MineradioDir "resources\app\public\js\modules\08-account\$pluginName"
$hookPath = "js/modules/08-account/$pluginName"

Write-Host "============================================"
Write-Host " Mineradio 免费音源优化插件 - 卸载"
Write-Host "============================================"

if (-not (Test-Path $indexLoader)) {
    Write-Host "[错误] 未找到 Mineradio 安装目录: $MineradioDir" -ForegroundColor Red
    exit 1
}

# 1. 移除加载钩子
$content = [System.IO.File]::ReadAllText($indexLoader, [System.Text.Encoding]::UTF8)
if ($content.Contains($hookPath)) {
    $content = $content.Replace("`r`n    '" + $hookPath + "',", "")
    $content = $content.Replace("    '" + $hookPath + "',`r`n", "")
    $content = $content.Replace("    '" + $hookPath + "',", "")
    [System.IO.File]::WriteAllText($indexLoader, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[OK] 加载钩子已从 index-loader.js 移除"
} else {
    Write-Host "[OK] 未发现加载钩子，跳过"
}

# 2. 删除插件脚本
if (Test-Path $pluginDst) {
    Remove-Item -Path $pluginDst -Force
    Write-Host "[OK] 插件脚本已删除: $pluginDst"
} else {
    Write-Host "[OK] 未发现插件脚本，跳过"
}

Write-Host ""
Write-Host "卸载完成！Mineradio 已恢复官方原样。" -ForegroundColor Green
