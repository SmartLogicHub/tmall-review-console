@echo off
setlocal
cd /d "%~dp0"

if not exist "data" mkdir "data"
set "DIAG_LOG=%CD%\data\browser-diagnosis.txt"
set "TMALL_DIAG_PROFILE=%TEMP%\tmall-browser-diagnosis-%RANDOM%-%RANDOM%"

echo Tmall browser launch diagnosis > "%DIAG_LOG%"
echo Date: %DATE% %TIME% >> "%DIAG_LOG%"
echo App directory: %CD% >> "%DIAG_LOG%"
echo. >> "%DIAG_LOG%"

echo [Windows] >> "%DIAG_LOG%"
ver >> "%DIAG_LOG%" 2>&1

echo. >> "%DIAG_LOG%"
echo [Runtime files] >> "%DIAG_LOG%"
if exist ".\runtime\node.exe" echo FOUND runtime\node.exe >> "%DIAG_LOG%"
if not exist ".\runtime\node.exe" echo MISSING runtime\node.exe >> "%DIAG_LOG%"
if exist ".\node_modules\patchright\index.js" echo FOUND node_modules\patchright\index.js >> "%DIAG_LOG%"
if not exist ".\node_modules\patchright\index.js" echo MISSING node_modules\patchright\index.js >> "%DIAG_LOG%"

if not exist ".\runtime\node.exe" goto wrong_folder
if not exist ".\node_modules\patchright\index.js" goto wrong_folder

".\runtime\node.exe" --version >> "%DIAG_LOG%" 2>&1
if "%TMALL_DIAG_SKIP_LAUNCH%"=="1" goto finished

echo. >> "%DIAG_LOG%"
echo [Chrome discovery and launch] >> "%DIAG_LOG%"
".\runtime\node.exe" -e "const fs=require('fs'),os=require('os'),path=require('path'),{chromium}=require('patchright');const roots=[process.env.LOCALAPPDATA,process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)']].filter(Boolean);const candidates=roots.map(r=>path.join(r,'Google','Chrome','Application','chrome.exe'));console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,windowsRelease:os.release(),chromeCandidates:candidates.map(p=>({path:p,exists:fs.existsSync(p)})),profile:process.env.TMALL_DIAG_PROFILE},null,2));chromium.launchPersistentContext(process.env.TMALL_DIAG_PROFILE,{channel:'chrome',headless:false,viewport:null,locale:'zh-CN',serviceWorkers:'block',timeout:30000,args:['--disable-extensions','--disable-blink-features=AutomationControlled','--disable-session-crashed-bubble','--no-first-run','--no-default-browser-check','--start-maximized']}).then(async c=>{console.log('LAUNCH_SUCCESS');await c.close()}).catch(e=>{console.error('LAUNCH_FAILED');console.error(e&&e.stack?e.stack:e);process.exitCode=1})" >> "%DIAG_LOG%" 2>&1
goto finished

:wrong_folder
echo. >> "%DIAG_LOG%"
echo ERROR: Copy this CMD file next to the Tmall assistant EXE, then run it again. >> "%DIAG_LOG%"

:finished
echo. >> "%DIAG_LOG%"
echo Diagnosis finished. >> "%DIAG_LOG%"
type "%DIAG_LOG%"
echo.
echo Send data\browser-diagnosis.txt to the developer.
pause
