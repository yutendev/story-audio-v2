# Story Audio v2 - Run All Tests
$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "1/3. Running Backend API Tests (Vitest)..." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
npm test --prefix apps/api

Write-Host "`n==========================================" -ForegroundColor Green
Write-Host "2/3. Running Frontend Web Tests (Vitest)..." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
npm test --prefix apps/web

Write-Host "`n==========================================" -ForegroundColor Yellow
Write-Host "3/3. Running Python Worker Tests (Pytest)..." -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Yellow
& "workers\python\.venv\Scripts\python.exe" -m pytest workers/python/tests -q

Write-Host "`n==========================================" -ForegroundColor Magenta
Write-Host "ALL TEST SUITES PASSED SUCCESSFULLY!" -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta
