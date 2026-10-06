@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AeroPrep - laisser cette fenetre ouverte
set "PATH=%PATH%;%ProgramFiles%\nodejs"

if not exist "node_modules" (
  echo AeroPrep n'est pas encore installe : lance d'abord INSTALLER-AEROPREP.bat
  pause
  exit /b 1
)

echo ============================================
echo   AeroPrep demarre sur http://localhost:3000
echo   Laisse cette fenetre ouverte pendant l'utilisation.
echo   Pour arreter AeroPrep : ferme cette fenetre.
echo ============================================
echo.

rem Ouvre le navigateur quand le serveur est pret
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'"

node --disable-warning=ExperimentalWarning server\index.js

echo.
echo AeroPrep s'est arrete (voir le message ci-dessus).
pause
