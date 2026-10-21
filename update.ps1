param(
    [string]$Server = "root@218.13.158.218",
    [string]$Repo = "wgfy1/fsu-monitor-platform"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-Update([string]$Message) {
    throw $Message
}

Write-Host "`n========== FSU 平台一键更新 ==========" -ForegroundColor Cyan

# 1. 检查分支
$branch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) { Stop-Update "Git 分支检查失败" }
if ($branch -ne "main") { Stop-Update "当前不是 main 分支，停止更新" }

# 2. 检查仓库地址
$origin = (git remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0) { Stop-Update "无法读取 GitHub 地址" }
$expectedOrigin = "https://github.com/$Repo.git"
if ($origin.TrimEnd("/") -ne $expectedOrigin) {
    Stop-Update "GitHub 地址不匹配：$origin"
}

# 3. 获取远端状态
git fetch origin
if ($LASTEXITCODE -ne 0) { Stop-Update "获取 GitHub 远端状态失败" }

$localHead = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { Stop-Update "无法读取本地 Commit" }

$remoteHead = (git rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0) { Stop-Update "无法读取远端 Commit" }

if ($localHead -ne $remoteHead) {
    Stop-Update "本地 main 与 origin/main 不一致，请先处理同步问题"
}

# 4. 检查工作区
$changes = git status --porcelain
if ($LASTEXITCODE -ne 0) { Stop-Update "Git 状态检查失败" }

if (-not $changes) {
    Write-Host "当前没有代码修改，停止部署。" -ForegroundColor Yellow
    exit 0
}

Write-Host "`n本次待提交文件：" -ForegroundColor Cyan
git status --short
if ($LASTEXITCODE -ne 0) { Stop-Update "文件状态检查失败" }

# 5. 输入提交说明
$message = Read-Host "请输入本次更新说明"
if ([string]::IsNullOrWhiteSpace($message)) {
    Stop-Update "提交说明不能为空"
}

# 6. 提交代码
git add -A
if ($LASTEXITCODE -ne 0) { Stop-Update "Git add 失败" }

git diff --cached --check
if ($LASTEXITCODE -ne 0) { Stop-Update "提交内容格式检查失败" }

git commit -m $message
if ($LASTEXITCODE -ne 0) { Stop-Update "Git commit 失败" }

# 7. 推送 GitHub
git push origin main
if ($LASTEXITCODE -ne 0) { Stop-Update "Git push 失败，未执行服务器部署" }

# 8. 获取并核对准确 Commit SHA
$sha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') {
    Stop-Update "无法获取有效 Commit SHA"
}

$remoteLine = git ls-remote origin refs/heads/main
if ($LASTEXITCODE -ne 0) { Stop-Update "无法核对 GitHub 远端版本" }

$remoteSha = (($remoteLine -split '\s+')[0]).Trim()
if ($remoteSha -ne $sha) {
    Stop-Update "GitHub 远端 SHA 与本地不一致，停止部署"
}

Write-Host "`n本次部署版本：$sha" -ForegroundColor Cyan

# 9. 服务器核验 Commit、下载归档并调用正式部署脚本
$remoteCommand = 'set -e; SHA=' + $sha +
    '; REPO=' + $Repo +
    '; META_SHA=$(curl -L --fail --silent --show-error --max-time 30 "https://api.github.com/repos/$REPO/commits/$SHA" | python3 -c ''import json,sys; print(json.load(sys.stdin).get(chr(115)+chr(104)+chr(97)))''); test "$META_SHA" = "$SHA"; ARCHIVE=/tmp/fsu-$SHA.tar.gz; curl -L --fail --silent --show-error --max-time 300 -o "$ARCHIVE" "https://api.github.com/repos/$REPO/tarball/$SHA"; test -s "$ARCHIVE"; bash /opt/fsu-platform/deploy.sh "$ARCHIVE"'

ssh $Server $remoteCommand
if ($LASTEXITCODE -ne 0) {
    Stop-Update "服务器下载或部署失败，请检查服务器输出；不要直接重复部署"
}

Write-Host "`n========== FSU 平台更新完成 ==========" -ForegroundColor Green
Write-Host "部署 Commit：$sha"
