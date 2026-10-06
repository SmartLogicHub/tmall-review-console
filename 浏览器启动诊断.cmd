@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "data" mkdir "data"
set "DIAG_LOG=%CD%\data\浏览器启动诊断结果.txt"
set "TMALL_DIAG_PROFILE=%TEMP%\tmall-browser-diagnosis-%RANDOM%-%RANDOM%"

echo 天猫评论助手浏览器启动诊断 > "%DIAG_LOG%"
echo 诊断时间：%DATE% %TIME% >> "%DIAG_LOG%"
echo 程序目录：%CD% >> "%DIAG_LOG%"
echo 临时资料目录：%TMALL_DIAG_PROFILE% >> "%DIAG_LOG%"
echo. >> "%DIAG_LOG%"

echo [Windows] >> "%DIAG_LOG%"
ver >> "%DIAG_LOG%" 2>&1
powershell.exe -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | Format-List" >> "%DIAG_LOG%" 2>&1

echo. >> "%DIAG_LOG%"
echo [Chrome 路径] >> "%DIAG_LOG%"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" echo FOUND "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" >> "%DIAG_LOG%"
if not exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" echo MISSING "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" >> "%DIAG_LOG%"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" echo FOUND "%ProgramFiles%\Google\Chrome\Application\chrome.exe" >> "%DIAG_LOG%"
if not exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" echo MISSING "%ProgramFiles%\Google\Chrome\Application\chrome.exe" >> "%DIAG_LOG%"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" echo FOUND "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" >> "%DIAG_LOG%"
if not exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" echo MISSING "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" >> "%DIAG_LOG%"
reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve >> "%DIAG_LOG%" 2>&1
reg.exe query "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve >> "%DIAG_LOG%" 2>&1

echo. >> "%DIAG_LOG%"
echo [评论助手运行环境] >> "%DIAG_LOG%"
if not exist ".\runtime\node.exe" (
  echo MISSING runtime\node.exe >> "%DIAG_LOG%"
  goto finished
)
if not exist ".\node_modules\patchright\index.js" (
  echo MISSING node_modules\patchright\index.js >> "%DIAG_LOG%"
  goto finished
)
".\runtime\node.exe" --version >> "%DIAG_LOG%" 2>&1

echo. >> "%DIAG_LOG%"
echo [使用全新临时资料启动 Chrome] >> "%DIAG_LOG%"
".\runtime\node.exe" -e "const os=require('os');const {chromium}=require('patchright');console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,windowsRelease:os.release(),profile:process.env.TMALL_DIAG_PROFILE},null,2));chromium.launchPersistentContext(process.env.TMALL_DIAG_PROFILE,{channel:'chrome',headless:false,viewport:null,locale:'zh-CN',serviceWorkers:'block',timeout:30000,args:['--disable-extensions','--disable-blink-features=AutomationControlled','--disable-session-crashed-bubble','--no-first-run','--no-default-browser-check','--start-maximized']}).then(async c=>{console.log('LAUNCH_SUCCESS');await c.close()}).catch(e=>{console.error('LAUNCH_FAILED');console.error(e&&e.stack?e.stack:e);process.exitCode=1})" >> "%DIAG_LOG%" 2>&1

:finished
echo. >> "%DIAG_LOG%"
echo 诊断结束。 >> "%DIAG_LOG%"
type "%DIAG_LOG%"
echo.
echo 请把 data\浏览器启动诊断结果.txt 发给开发人员。
pause
