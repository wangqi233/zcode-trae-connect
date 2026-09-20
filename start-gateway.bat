@echo off
rem trae2api - Trae (China / Global) to OpenAI-compatible local gateway.
rem Reads credentials from the signed-in Trae client's storage.json and serves
rem an OpenAI + Anthropic compatible API on http://127.0.0.1:19950
setlocal
cd /d "%~dp0"

rem --- API key clients must send (Bearer). Change it, or set it in .env ---
set "API_KEY=sk-trae2api-local"

rem Port 19950, not 19900: Windows winnat/Hyper-V reserves 19839-19938, so binding
rem 19900 fails with EACCES ("permission denied") for no obvious reason.
set "PORT=19950"

rem --- Product line ---
rem solo = TRAE SOLO pools (solo_work_lite; light queue) -- recommended for model work.
rem trae = classic Trae client pools (chat_v3; heavy queue).
set "TRAE_PRODUCT=solo"

rem --- Multi-account pool ---
rem Members live as account-<userId>.json under this dir and contain PLAINTEXT
rem tokens (treat the dir like the accounts themselves; it is git-ignored).
rem Members are auto-imported/renewed by hot-import, which scans the product data
rem dirs plus TraeWork-CN-N dirs, so staging a storage.json into
rem   %APPDATA%\TraeWork-CN-<N>\User\globalStorage\
rem is enough to add an account -- no client install needed.
set "TRAE_POOL_DIR=%~dp0accounts"

rem --- Pool token self-renewal ---
rem off: serve imported tokens as-is; tokens renew only when a client re-logins
rem      (hot-import picks the new token up). Prevents ExchangeToken from rotating
rem      the token family behind an idle client's back and logging it out.
rem on : allow the gateway to renew expiring tokens itself.
set "TRAE_POOL_SELF_RENEW=off"

rem --- Realm selection ---
rem Unset: the gateway derives the realm from whichever credential it loads.
rem Set TRAE_EDITION=cn|sg to pin one realm. When accounts from both realms are
rem present it also routes per request by model name, so no pin is usually needed.
rem set "TRAE_EDITION=cn"

set NODE_ENV=production
echo Starting trae2api on http://127.0.0.1:%PORT%
node src/server.js
