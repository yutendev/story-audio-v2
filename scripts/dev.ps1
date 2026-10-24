# scripts/dev.ps1 — T9.4: MỘT lệnh khởi động dev: PostgreSQL (compose) + API + Web.
# Kiểm prereq trước (thiếu → báo rõ, không nửa vời).
# Ctrl+C trong cửa sổ này dừng cả API + Web (cùng console group): Node nhận SIGINT
# → gracefulShutdown (T3.6); job còn running được requeueOrphanedJobs ở lần boot sau.
# Script KHÔNG bao giờ in giá trị .env (chỉ kiểm sự tồn tại).
param()

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Fail($msg) { Write-Host "LỖI: $msg" -ForegroundColor Red; exit 1 }

# --- 1) Prereq ---
if (-not (Test-Path (Join-Path $repo ".env"))) {
    Fail "thiếu .env — copy .env.example rồi điền (xem docs/runbooks/dev-setup.md)"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "chưa có node trong PATH (cần Node 22 LTS)" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail "chưa có docker trong PATH (cần Docker Desktop)" }
ffmpeg -version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "chưa có ffmpeg/ffprobe trong PATH (cần FFmpeg 8.x)" }

# --- 2) PostgreSQL local (compose) + chờ healthy ---
Write-Host ">> docker compose up -d db (story-audio-db, host 5454)"
docker compose up -d db; if ($LASTEXITCODE -ne 0) { Fail "không dựng được container db — kiểm Docker Desktop + POSTGRES_* trong .env" }
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    $ps = docker compose ps db 2>$null | Out-String
    if ($ps -match "(healthy)") { $healthy = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $healthy) { Fail "db chưa healthy sau 30s — xem: docker compose logs db" }

# --- 3) Phụ thuộc (idempotent: chỉ cài khi thiếu) ---
if (-not (Test-Path "apps\api\node_modules")) { Write-Host ">> npm install apps/api"; npm install --prefix apps\api; if ($LASTEXITCODE -ne 0) { Fail "npm install apps/api lỗi" } }
if (-not (Test-Path "apps\api\src\generated\client")) {
    Write-Host ">> prisma generate (apps/api)"
    Set-Location apps\api; npx prisma generate --schema prisma/schema.prisma; Set-Location $repo
    if ($LASTEXITCODE -ne 0) { Fail "prisma generate lỗi" }
}
Write-Host ">> prisma migrate deploy (apps/api)"
Set-Location apps\api; npx prisma migrate deploy --schema prisma/schema.prisma; Set-Location $repo
if ($LASTEXITCODE -ne 0) { Fail "prisma migrate deploy lỗi — DATABASE_URL trong .env đúng host 5454 chưa?" }
if (-not (Test-Path "apps\web\node_modules")) { Write-Host ">> npm install apps/web"; npm install --prefix apps\web; if ($LASTEXITCODE -ne 0) { Fail "npm install apps/web lỗi" } }
if (-not (Test-Path "workers\python\.venv")) {
    Write-Host ">> tạo venv Python 3.12 workers/python (lần đầu)"
    python -m venv workers\python\.venv; if ($LASTEXITCODE -ne 0) { Fail "tạo venv lỗi — cần Python 3.12" }
    workers\python\.venv\Scripts\pip install -e "workers/python[test]"; if ($LASTEXITCODE -ne 0) { Fail "pip install worker lỗi" }
}

# --- 4) Chạy API + Web (cùng console — Ctrl+C dừng cả hai) ---
# Windows: Get-Command "npm" có thể trả shim bash (không phải exe Win32) — buộc npm.cmd
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { Fail "không tìm thấy npm.cmd trong PATH (Node 22 LTS chưa vào PATH?)" }
$npm = $npmCmd.Source
Write-Host ">> khởi động API (:3000) + Web (:5173)"
$api = Start-Process -FilePath $npm -ArgumentList "run","dev" -WorkingDirectory "$repo\apps\api" -NoNewWindow -PassThru
$web = Start-Process -FilePath $npm -ArgumentList "run","dev" -WorkingDirectory "$repo\apps\web" -NoNewWindow -PassThru

function Wait-HttpOk([string]$url, [int]$tries) {
    for ($i = 0; $i -lt $tries; $i++) {
        if ($api.HasExited -or $web.HasExited) { return $false }
        try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { return $true } } catch { }
        Start-Sleep -Seconds 1
    }
    return $false
}

try {
    # probe mỗi server theo đúng host nó bind (đã thử nghiệm thật):
    # - API fastify bind 0.0.0.0 (IPv4) → dùng 127.0.0.1; "localhost:3000" thử ::1 trước → timeout dưới 3s
    # - Vite bind "localhost" (::1/IPv6 trên máy dev này) → dùng localhost; "127.0.0.1:5173" refused dù Vite sống
    if (-not (Wait-HttpOk "http://127.0.0.1:3000/api/jobs?limit=1" 30)) { throw "API không lên được 127.0.0.1:3000 trong 30s — xem log phía trên" }
    if (-not (Wait-HttpOk "http://localhost:5173/" 25)) { throw "Web không lên được localhost:5173 trong 25s — xem log phía trên" }
    Write-Host "API  ready: http://localhost:3000  (health: /api/jobs?limit=1)" -ForegroundColor Green
    Write-Host "Web  ready: http://localhost:5173" -ForegroundColor Green
    Write-Host "Ctrl+C để dừng cả hai (graceful, T3.6)." -ForegroundColor Yellow
    while (-not $api.HasExited -and -not $web.HasExited) { Start-Sleep -Seconds 2 }
} catch {
    Write-Host "LỖI: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    foreach ($p in @($api, $web)) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    # npm.cmd chỉ là wrapper — kill cả node còn lắng nghe 3000/5173 (chống mồ côi)
    foreach ($port in 3000, 5173) {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "đã dừng dev (db giữ nguyên — docker compose down nếu muốn)."
}
