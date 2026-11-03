@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [1/2] 首次运行，创建虚拟环境并安装依赖...
    python -m venv .venv || goto :err
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :err
) else (
    echo [1/2] 虚拟环境已存在，跳过安装
)

echo [2/2] 启动 TokenURL 服务...
echo     本机访问: http://127.0.0.1:5000
echo     默认账号: admin / admin123  ^(首次登录后请立即修改^)
echo     停止服务: Ctrl+C
echo.
".venv\Scripts\python.exe" app.py
goto :eof

:err
echo.
echo 启动失败，请确认已安装 Python 3.9+ 并加入 PATH。
pause
