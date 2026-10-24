# Workflow: Chạy Toàn Bộ Test Suite (Full Test Suite)

Quy trình chạy kiểm thử 3 tầng độc lập (Node API, React Web, Python Worker) để đảm bảo không bị regression.

---

## 1. Yêu cầu trước khi chạy
- Docker container `story-audio-db` phải đang chạy (port 5454) phục vụ cho API tests.
- Python virtual environment đã sẵn sàng tại `workers/python/.venv`.

---

## 2. Thứ tự thực thi

### Bước 1: Kiểm thử Backend API (Vitest)
```powershell
npm test --prefix apps/api
# Hoặc: cd apps/api; npx vitest run
```
* **Kỳ vọng:** Toàn bộ 22 test files pass (188+ tests).

### Bước 2: Kiểm thử Frontend Web (Vitest)
```powershell
npm test --prefix apps/web
# Hoặc: cd apps/web; npx vitest run
```
* **Kỳ vọng:** Toàn bộ 4 test files pass (20 tests).

### Bước 3: Kiểm thử Python Worker (Pytest)
```powershell
workers\python\.venv\Scripts\python.exe -m pytest workers/python/tests -q
```
* **Kỳ vọng:** 161+ passed, 3 skipped (các test opt-in live network/ffmpeg).
