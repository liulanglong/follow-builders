@echo off
REM ============================================================================
REM Follow Builders 日报 - 每日定时拉取并发送
REM ----------------------------------------------------------------------------
REM 用 Windows 任务计划程序调用本 bat (每天定时, 如上午 10:00)
REM 流程: git pull 公网仓库 -> node send-local.js 读最新日报 -> SMTP 发邮件
REM
REM 注意: FB_REPO 已经设成本仓库路径, 若仓库移动了请同步修改
REM ============================================================================

REM --- 配置: 本地仓库路径 ---
set "FB_REPO=D:\projects\follow-builders"

cd /d "%FB_REPO%" || (
  echo [ERROR] 仓库路径不存在: %FB_REPO%
  exit /b 1
)

echo [1/2] git pull 拉取最新成品日报...
git pull --ff-only
if errorlevel 1 (
  echo [WARN] git pull 有问题, 继续尝试发送已有的最新日报
)

echo [2/2] 发送邮件...
cd scripts
node send-local.js
if errorlevel 1 (
  echo [ERROR] 发送失败
  exit /b 1
)

echo [DONE] 完成
