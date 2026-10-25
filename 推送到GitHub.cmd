@echo off
chcp 65001 >nul
title 麦点点 · 推送到 GitHub
cd /d "%~dp0"

echo.
echo   麦点点 · 推送到 GitHub
echo   ------------------------------------------------
echo   仓库： https://github.com/Dxg-Tmy/WayToAgi-Dine
echo   分支： master -^> main
echo.
echo   说明：当前网络下 github.com 直连不通，本脚本已内置可用 IP。
echo   若提示输入凭据：Username 填 Dxg-Tmy，Password 粘贴
echo   GitHub Personal Access Token（需 repo 权限）。
echo.

REM 首选 IP 覆盖（绕开 DNS 指向的失效节点），失败则回落到直连
set "GIT_TERMINAL_PROMPT=1"
git -c http.curloptResolve=github.com:443:140.82.112.3 push --force-with-lease=main:dc15f17f6f88f7da0579e55d374018be2411596c origin master:main
if %errorlevel%==0 goto OK

echo.
echo   用备用 IP 再试一次...
git -c http.curloptResolve=github.com:443:140.82.113.3 push --force-with-lease=main:dc15f17f6f88f7da0579e55d374018be2411596c origin master:main
if %errorlevel%==0 goto OK

echo.
echo   [失败] 若提示 could not read Username，说明缺少凭据：
echo     1) 在 https://github.com/settings/tokens 生成一个 PAT（勾 repo 权限）
echo     2) 或先在 WorkBuddy 里连接 GitHub 连接器
echo.

goto END

:OK
echo.
echo   [成功] 已推送到 https://github.com/Dxg-Tmy/WayToAgi-Dine  (main 分支)
echo   验证： https://github.com/Dxg-Tmy/WayToAgi-Dine
echo.

:END
pause
