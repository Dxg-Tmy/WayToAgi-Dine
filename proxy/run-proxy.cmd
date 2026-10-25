@echo off
REM 麦点点本地代理启动脚本（供 Windows 计划任务调用，脱离会话独立运行）
cd /d "%~dp0"
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.mjs >> "%~dp0proxy.log" 2>&1
