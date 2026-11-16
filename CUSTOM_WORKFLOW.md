# Quy trình đồng bộ code từ repo gốc (Upstream)

Repo này được fork từ `agentes-chat/agentes-chat` (`upstream`) về `tienchinh21/agentes-chat` (`origin`).

- `main`: Giữ sạch giống hệt `upstream/main`.
- `custom/main`: Nhánh chính của công ty (chứa giao diện Tiếng Việt và các tùy biến riêng).

## 1. Kéo cập nhật mới từ dự án gốc về `custom/main`

```sh
git fetch upstream
git checkout main && git merge upstream/main && git push origin main
git checkout custom/main && git merge main && git push origin custom/main
```

## 2. Chạy dự án ở local

```sh
# Đảm bảo container Postgres (agentes-pg) đang chạy
docker start agentes-pg

# Cài dependencies nếu vừa kéo update mới và chạy dev
bun install
bun run dev
```

## 3. Cập nhật thêm chuỗi Tiếng Việt (nếu bản gốc thêm text mới)

```sh
bun run i18n:missing vi --file app
# Sau đó dịch bổ sung rồi gộp lại:
bun run i18n:apply vi i18n-work/vi.done.json
```
