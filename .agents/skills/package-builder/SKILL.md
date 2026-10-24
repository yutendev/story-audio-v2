---
name: package-builder
description: >-
  Đóng gói audiobook định dạng M4B (kèm chapter markers) và video MP4 (kèm timestamps)
  bằng FFmpeg thông qua Python worker.
---

# Package Builder Skill

Sử dụng skill này khi cần kiểm tra hoặc tái đóng gói các file audio thành phẩm thành sách nói định dạng M4B hoặc video YouTube MP4.

## Các bước thực hiện

1. Kiểm tra môi trường FFmpeg:
   ```powershell
   ffmpeg -version
   ffprobe -version
   ```

2. Kiểm tra tính năng ghép gói M4B (offline qua mocks):
   ```powershell
   workers\python\.venv\Scripts\python.exe -m pytest workers/python/tests/test_package.py workers/python/tests/test_package_builder.py -q
   ```

3. Tái đóng gói không cần chạy lại AI/TTS:
   - Khi thay đổi cấu hình số chương mỗi gói (`chaptersPerBook`), hệ thống chỉ gom lại các audio parts sẵn có trên R2/workdir.
   - Không được phép kích hoạt lại công đoạn viết lại AI hoặc gọi Edge-TTS.

4. Xuất video MP4 (tùy chọn):
   - Tạo thumbnail kích thước chuẩn 1280x720 hoặc 1920x1080.
   - Tạo file `description.txt` chứa danh sách mốc thời gian (timestamps) tương ứng từng chương.
