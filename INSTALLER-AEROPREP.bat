@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Installation d'AeroPrep

echo ============================================
echo   Installation d'AeroPrep
echo ============================================
echo.

rem --- 1. Node.js (22.13 ou plus recent) -----------------------------------
set "PATH=%PATH%;%ProgramFiles%\nodejs"
call :check_node
if not errorlevel 1 goto node_ok

echo Node.js n'est pas installe (ou trop ancien). Installation en cours...
where winget >nul 2>nul
if errorlevel 1 goto no_winget
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
set "PATH=%PATH%;%ProgramFiles%\nodejs"
call :check_node
if not errorlevel 1 goto node_ok
echo.
echo Node.js vient d'etre installe mais n'est pas encore visible.
echo Ferme cette fenetre et relance INSTALLER-AEROPREP.bat.
pause
exit /b 1

:no_winget
echo.
echo Impossible d'installer Node.js automatiquement sur ce PC.
echo La page de telechargement va s'ouvrir : installe la version "LTS",
echo puis relance INSTALLER-AEROPREP.bat.
start "" https://nodejs.org/fr/download
pause
exit /b 1

:node_ok
for /f "delims=" %%v in ('node -v') do echo Node.js %%v : OK
echo.

rem --- 2. Dependances -------------------------------------------------------
echo Telechargement des composants (1 a 2 minutes)...
call npm ci --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo L'installation des composants a echoue. Verifie ta connexion internet et relance.
  pause
  exit /b 1
)
echo.

rem --- 3. Configuration -------------------------------------------------------
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo Fichier de configuration .env cree.
)

rem --- 4. Raccourci sur le bureau ---------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\AeroPrep.lnk'); $s.TargetPath='%~dp0LANCER-AEROPREP.bat'; $s.WorkingDirectory='%~dp0'; $s.Description='Lancer AeroPrep'; $s.Save()" >nul 2>nul
if not errorlevel 1 echo Raccourci "AeroPrep" ajoute sur le bureau.

echo.
echo ============================================
echo   Installation terminee !
echo   AeroPrep va demarrer. Le premier compte cree sera administrateur.
echo ============================================
echo.
pause
call "%~dp0LANCER-AEROPREP.bat"
exit /b 0

:check_node
where node >nul 2>nul || exit /b 1
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" 2>nul
exit /b %errorlevel%
