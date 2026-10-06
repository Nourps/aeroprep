@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Acces Internet AeroPrep (DuckDNS + HTTPS)

echo ============================================
echo   Acces depuis Internet : https://TONNOM.duckdns.org
echo ============================================
echo.
echo Avant de continuer :
echo  1. Cree un compte gratuit sur https://www.duckdns.org
echo  2. Ajoute un sous-domaine (ex. monaeroprep) et copie ton token
echo.
set /p DDNAME=Sous-domaine DuckDNS (sans .duckdns.org) : 
set /p DDTOKEN=Token DuckDNS : 
if "%DDNAME%"=="" goto missing
if "%DDTOKEN%"=="" goto missing

rem --- 1. Caddy (serveur HTTPS) avec le module DuckDNS -------------------------
if not exist "tools" mkdir tools
echo.
echo Telechargement de Caddy (serveur HTTPS, certificat Let's Encrypt automatique)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://caddyserver.com/api/download?os=windows&arch=amd64&p=github.com/caddy-dns/duckdns' -OutFile 'tools\caddy.exe'"
if not exist "tools\caddy.exe" (
  echo Echec du telechargement de Caddy. Verifie ta connexion internet et relance.
  pause
  exit /b 1
)

rem --- 2. Configuration ---------------------------------------------------------
(
  echo %DDNAME%.duckdns.org {
  echo 	encode gzip
  echo 	tls {
  echo 		dns duckdns %DDTOKEN%
  echo 	}
  echo 	request_body {
  echo 		max_size 300MB
  echo 	}
  echo 	reverse_proxy 127.0.0.1:3000
  echo }
) > "tools\Caddyfile"

rem Le serveur AeroPrep met a jour l'adresse IP DuckDNS toutes les 5 minutes
if not exist ".env" copy /y ".env.example" ".env" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='.env'; $l=Get-Content $f | Where-Object { $_ -notmatch '^(DUCKDNS_DOMAIN|DUCKDNS_TOKEN)=' }; $l += 'DUCKDNS_DOMAIN=%DDNAME%'; $l += 'DUCKDNS_TOKEN=%DDTOKEN%'; Set-Content -Path $f -Value $l -Encoding UTF8"

rem --- 3. Pare-feu Windows (demande l'autorisation administrateur) -------------
echo.
echo Ouverture du port 443 dans le pare-feu Windows (accepte la demande d'autorisation)...
powershell -NoProfile -Command "Start-Process -Verb RunAs -Wait -FilePath netsh -ArgumentList 'advfirewall firewall add rule name=AeroPrep-HTTPS dir=in action=allow protocol=TCP localport=443'" 

echo.
echo ============================================
echo   Configuration terminee !
echo.
echo   IL RESTE UNE ETAPE A FAIRE DANS TA BOX :
echo   rediriger le port 443 (TCP) vers l'adresse IP locale de ce PC.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo   Adresse IP locale de ce PC :%%a
echo   (et reserve cette adresse dans le DHCP de la box pour qu'elle ne change pas)
echo.
echo   Ensuite relance AeroPrep avec le raccourci du bureau :
echo   https://%DDNAME%.duckdns.org sera accessible depuis Internet.
echo   Le premier acces peut prendre 1 a 2 minutes (creation du certificat).
echo ============================================
pause
exit /b 0

:missing
echo Sous-domaine ou token manquant. Relance le script.
pause
exit /b 1
