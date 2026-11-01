#Requires -Version 5.1
<#
.SYNOPSIS
    把 ZJOOC 自动刷课脚本安装到 OCS Desktop 的静态目录，并给出可用的「网络脚本」地址。

.DESCRIPTION
    OCS Desktop 的浏览器是「Chrome for Testing + ScriptCat」。
    它的「添加本地脚本」会把脚本拼成 file:// 去导航，而 Chrome 扩展默认没有文件访问权限，
    所以会永远卡在"正在安装用户脚本…"。正确做法是用 OCS 自带的静态服务：
      resources\app\public\  <-- 也就是 http://localhost:15319/ 的根目录
    本脚本负责把 zjooc-auto.user.js 复制进去并验证可访问。

.PARAMETER OcsPath
    OCS Desktop 安装目录。默认自动探测 %LOCALAPPDATA%\Programs\OCS Desktop。

.PARAMETER Source
    要安装的脚本文件。默认取本脚本同目录下的 zjooc-auto.user.js。

.PARAMETER NoVerify
    跳过"复制后通过 http://localhost:15319 验证"这一步（OCS 没启动时自动跳过）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    .\install.ps1 -OcsPath "D:\Apps\OCS Desktop"
#>
[CmdletBinding()]
param(
    [string]$OcsPath,
    [string]$Source,
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$FileName = 'zjooc-auto.user.js'
$Port = 15319

function Write-Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "[x] $msg" -ForegroundColor Red }

# ---------- 1. 找源文件 ----------
if (-not $Source) { $Source = Join-Path $PSScriptRoot $FileName }
if (-not (Test-Path -LiteralPath $Source)) {
    Write-Err2 "找不到脚本文件：$Source"
    exit 1
}

# ---------- 2. 找 OCS 安装目录 ----------
$candidates = @()
if ($OcsPath) { $candidates += $OcsPath }
$candidates += (Join-Path $env:LOCALAPPDATA 'Programs\OCS Desktop')
$candidates += 'C:\Program Files\OCS Desktop'
$candidates += 'C:\Program Files (x86)\OCS Desktop'

$publicDir = $null
foreach ($c in $candidates) {
    if (-not $c) { continue }
    $p = Join-Path $c 'resources\app\public'
    if (Test-Path -LiteralPath $p) { $publicDir = $p; $OcsPath = $c; break }
}
if (-not $publicDir) {
    Write-Err2 '没有找到 OCS Desktop 的静态目录。请用 -OcsPath 指定安装目录，例如：'
    Write-Host '    .\install.ps1 -OcsPath "C:\Users\<你>\AppData\Local\Programs\OCS Desktop"'
    exit 1
}

# ---------- 3. 复制 ----------
$dest = Join-Path $publicDir $FileName
Copy-Item -LiteralPath $Source -Destination $dest -Force
$bytes = (Get-Item -LiteralPath $dest).Length
$version = 'unknown'
$m = Select-String -LiteralPath $dest -Pattern '^//\s*@version\s+(\S+)' | Select-Object -First 1
if ($m) { $version = $m.Matches[0].Groups[1].Value }
Write-Ok "已安装：$dest （v$version, $bytes 字节）"

# ---------- 4. 验证本地服务 ----------
$url = "http://localhost:$Port/$FileName"
if (-not $NoVerify) {
    $running = $false
    try {
        $running = [bool](Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue)
    } catch { $running = $false }

    if (-not $running) {
        Write-Warn2 "OCS 没在运行（端口 $Port 未监听），跳过验证。启动 OCS 后可重新运行本脚本。"
    } else {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
            if ($r.StatusCode -eq 200) {
                Write-Ok "本地地址可用：$url （$($r.RawContentLength) 字节）"
            } else {
                Write-Warn2 "本地地址返回 $($r.StatusCode)，可能 OCS 还没启动完。"
            }
        } catch {
            Write-Warn2 "访问 $url 失败：$($_.Exception.Message)"
        }
    }
}

# ---------- 5. 收尾提示 ----------
Write-Host ''
Write-Host '接下来在 OCS Desktop 里操作：' -ForegroundColor White
Write-Host '  1) 左侧「用户脚本」页：把旧的【本地脚本】条目删掉（否则启动会卡在"正在安装用户脚本"）'
Write-Host '  2) 点「添加网络脚本」，填：'
Write-Host "       $url" -ForegroundColor Green
Write-Host '  3) 启动浏览器；右下角出现面板即成功（标题旁有版本号）'
Write-Host ''
Write-Host '如果面板不出现，见 README「常见问题」：chrome://extensions 开开发者模式 + 重新加载 ScriptCat。' -ForegroundColor DarkGray
