@echo off
chcp 65001 >nul
title 麦点点 · 本地代理（不要关闭此窗口）
cd /d "%~dp0proxy"
echo.
echo   麦点点 · 麦当劳 MCP 本地代理
echo   ------------------------------------------------
echo   地址：http://localhost:8787
echo   保持这个窗口开着，网页才能实时取菜单 / 真实下单。
echo   关闭本窗口 = 停止代理。
echo.
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.mjs
echo.
echo   代理已退出（按任意键关闭窗口）
pause >nul
