# 一键发布到 GitHub（公开仓库 <你的用户名>/dsh-dynamic-island）。不发布 npm。
# 登录都在浏览器里完成，本脚本不读取、不保存任何密码或令牌。
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = '发布 DeepSeek 灵动岛'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root

function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Done([string]$text) { Write-Host "   $text" -ForegroundColor Green }
function Fail([string]$text) { throw $text }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
# 结果写在 $script:RetryOk，命令自己的输出照常显示在窗口里。
function Retry([scriptblock]$Action, [string]$What, [scriptblock]$Already = { $false }) {
  $script:RetryOk = $false
  for ($i = 1; $i -le 3; $i++) {
    if ([bool](& $Already)) { $script:RetryOk = $true; return }
    & $Action
    if ($LASTEXITCODE -eq 0) { $script:RetryOk = $true; return }
    if ([bool](& $Already)) { $script:RetryOk = $true; return }
    if ($i -lt 3) { Write-Host "   $What 没有成功（第 $i 次），5 秒后重试…" -ForegroundColor Yellow; Start-Sleep -Seconds 5 }
  }
}
function Need([string]$cmd, [string]$wingetId, [string]$name) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  Write-Host "   没有找到 $name。" -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $answer = Read-Host "   用 winget 安装 $name 吗？(Y/N)"
    if ($answer -match '^[Yy]') { winget install --id $wingetId -e --accept-source-agreements --accept-package-agreements; Refresh-Path }
  }
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "请先安装 $name，然后重新运行本脚本。" }
}

try {
  $pkgName = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).name
  # 只对本脚本使用官方源：国内镜像是只读的，不能登录发布。不改动你的全局 npm 设置。
  $reg = 'https://registry.npmjs.org/'
  $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version

  Step '检查 Git、GitHub CLI、Node.js'
  Need git 'Git.Git' 'Git'
  Need gh 'GitHub.cli' 'GitHub CLI'
  Need npm 'OpenJS.NodeJS.LTS' 'Node.js'
  Done '工具齐全'

  Step '登录 GitHub（浏览器）'
  gh auth status --hostname github.com *> $null
  if ($LASTEXITCODE -ne 0) {
    gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { Fail 'GitHub 登录没有完成。' }
  }
  gh auth setup-git *> $null
  $login = (gh api user --jq .login).Trim()
  $userId = (gh api user --jq .id).Trim()
  if (-not $login) { Fail '读取不到 GitHub 用户名。' }
  $repo = "$login/$pkgName"
  $url = "https://github.com/$repo"
  Done "已登录：$login"

  Step "准备仓库 $repo"
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.author=p.author||process.argv[1];p.repository={type:'git',url:'git+'+process.argv[2]+'.git'};p.homepage=process.argv[2]+'#readme';p.bugs={url:process.argv[2]+'/issues'};fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')" $login $url
  if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) { git init -b main | Out-Null }
  git config core.autocrlf false
  if (-not (git config user.name)) { git config user.name $login }
  if (-not (git config user.email)) { git config user.email "$userId+$login@users.noreply.github.com" }
  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { git commit -q -m "DeepSeek Island $version"; if ($LASTEXITCODE -ne 0) { Fail 'git 提交失败。' } }
  $repoExists = { gh repo view $repo *> $null; $LASTEXITCODE -eq 0 }
  Retry { gh repo create $repo --public --description 'DeepSeek Harness desktop dynamic island plugin (community)' --homepage "https://github.com/$repo" } '创建 GitHub 仓库' $repoExists
  if (-not $script:RetryOk) { Fail "创建仓库 $repo 失败，请检查网络或代理后重新运行。" }
  git remote get-url origin *> $null
  if ($LASTEXITCODE -ne 0) { git remote add origin "$url.git" }
  Retry { git push -u origin HEAD:main } '推送代码'
  if (-not $script:RetryOk) { Fail "推送到 $repo 失败，请检查网络或代理后重新运行。" }
  git tag -f "v$version" | Out-Null
  Retry { git push -f origin "v$version" *> $null } '推送标签'
  gh repo edit $repo --add-topic deepseek --add-topic deepseek-harness --add-topic dynamic-island --add-topic electron *> $null
  Done "GitHub：$url"

  Write-Host ''
  Write-Host 'GitHub 发布完成（未发布 npm）。' -ForegroundColor Green
  Write-Host "  GitHub  $url"
  Write-Host "  Release  https://github.com/$repo/releases/tag/v$version"
  Write-Host '  安装：下载仓库后双击「安装到 Harness.cmd」，或用 dsh plugin --profile desktop add <tgz>。'
} catch {
  Write-Host ''
  Write-Host "没有完成：$($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ''
Read-Host '按回车关闭'
