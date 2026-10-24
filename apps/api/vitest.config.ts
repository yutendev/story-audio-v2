import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Các test file dùng chung 1 DB dev thật — chạy tuần tự để không claim/clean chéo nhau
    fileParallelism: false,
  },
});
