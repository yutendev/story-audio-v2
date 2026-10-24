# Workflow: Khởi động Môi trường Phát triển (Dev Environment)

Quy trình chuẩn để khởi chạy toàn bộ hệ thống trên môi trường Windows local.

---

## Các bước thực hiện

### 1. Khởi chạy Database
Chạy PostgreSQL 17 qua Docker Compose:
```powershell
docker compose up -d db
```
* Kiểm tra container đang chạy: `docker ps --filter "name=story-audio-db"`
* Cổng ánh xạ: `localhost:5454`

### 2. Áp dụng Database Migration
Tại thư mục `apps/api`:
```powershell
npm run prisma:generate --prefix apps/api
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

### 3. Chạy toàn bộ Stack bằng script tích hợp
Sử dụng script PowerShell có sẵn ở thư mục gốc:
```powershell
.\scripts\dev.ps1
```
Script này sẽ tự động:
- Khởi động DB (nếu chưa chạy)
- Khởi động API Server (`http://localhost:3000`)
- Khởi động Web Frontend Vite (`http://localhost:5173`)
