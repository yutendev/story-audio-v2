# Centralized Test Runner — Story Audio v2

Thư mục này đóng vai trò điều phối kiểm thử tổng hợp cho toàn bộ dự án `story-audio-v2`.

Các bộ kiểm thử chi tiết được đặt tại:
- **API Tests:** `apps/api/tests/` (Vitest - 22 files)
- **Web Tests:** `apps/web/tests/` (Vitest - 4 files)
- **Worker Tests:** `workers/python/tests/` (Pytest - 13 files)

---

## Cách chạy kiểm thử nhanh

### 1. Chạy toàn bộ test suites trong một lệnh
Sử dụng script PowerShell:
```powershell
.\tests\run-all.ps1
```

### 2. Chạy riêng lẻ từng phần
- **API:** `npm test --prefix apps/api`
- **Web:** `npm test --prefix apps/web`
- **Worker:** `workers\python\.venv\Scripts\python.exe -m pytest workers/python/tests -q`
