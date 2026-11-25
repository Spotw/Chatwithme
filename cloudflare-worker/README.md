# WaterCrawl → Cloudflare D1

Worker độc lập với backend Django: phục vụ giao diện, gọi WaterCrawl bằng REST API và lưu Markdown vào D1. Không cần triển khai Django lên Workers.

Đích triển khai: Worker `watercrawl-d1`, domain `https://chat.pvdv.space`, D1 `chatbox` (`9b4d1d6c-b6bc-440a-b705-aaef9997ace2`). Cấu hình account/domain/database nằm trong [wrangler.jsonc](./wrangler.jsonc); secrets được nhập riêng qua Wrangler.

## Luồng xử lý

1. Kết nối giao diện bằng `APP_TOKEN` dùng chung của workspace.
2. `POST /api/jobs` tạo tác vụ trong D1, gửi một URL đến WaterCrawl bằng header `X-API-Key`, lưu UUID phía WaterCrawl.
3. Giao diện kiểm tra mỗi 5 giây. Cron mỗi phút tiếp tục kiểm tra kể cả khi đóng tab.
4. Khi `status=finished`, lấy `/results/?prefetched=true&page_size=1` để nhận JSON trực tiếp, không tải URL lưu trữ tùy ý.
5. Một D1 transaction cập nhật trang theo URL và đánh dấu tác vụ đã lưu. Tác vụ cũ hoàn tất muộn không ghi đè nội dung từ tác vụ mới.

## Cấu hình

Yêu cầu Node.js 22.13+ (khuyến nghị Node 24, tests dùng `node:sqlite`) và tài khoản Cloudflare có Workers/D1.

```powershell
cd cloudflare-worker
npm.cmd install
npx.cmd wrangler login
```

Trong [wrangler.jsonc](./wrangler.jsonc):

- `name`: tên Worker mong muốn.
- `account_id`: đã gán tài khoản Cloudflare sở hữu database của dự án.
- `routes`: Custom Domain `chat.pvdv.space`, Cloudflare quản lý DNS và certificate khi deploy.
- `d1_databases[0].database_name` và `database_id`: đã gán D1 `chatbox` được chỉ định. Không tạo database mới khi triển khai dự án này.
- `WATERCRAWL_BASE_URL`: origin của WaterCrawl, không thêm `/api`. Dùng cloud mặc định hoặc máy chủ self-host có HTTPS công khai. Worker trên Cloudflare không kết nối được `localhost` trên PC của bạn.

Không dùng tên/ID từ dự án khác. Không commit API key hoặc token.

## Chạy local

```powershell
Copy-Item .dev.vars.example .dev.vars
# Điền WATERCRAWL_API_KEY thật và APP_TOKEN ngẫu nhiên ít nhất 24 ký tự vào .dev.vars.
npm.cmd run db:local
npm.cmd run dev
```

Mở URL Wrangler trả về (thường `http://localhost:8787`), bấm **Kết nối**, nhập `APP_TOKEN`, dán URL và bấm mũi tên. APP_TOKEN chỉ nằm trong bộ nhớ tab, không được ghi vào localStorage. Tải lại trang cần kết nối lại; thư viện và tác vụ vẫn ở D1. Preview hiện Markdown dưới dạng văn bản an toàn và cho tải xuống.

Local Wrangler không tự chạy cron. Với phiên bản Wrangler trong lockfile, gọi `http://localhost:8787/cdn-cgi/local/scheduled` để kích hoạt thủ công (hoặc dùng URL hướng dẫn được in khi khởi động nếu phiên bản khác). Giao diện vẫn kiểm tra tiến độ khi mở.

## Kiểm tra và deploy

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run db:remote
npx.cmd wrangler secret put WATERCRAWL_API_KEY
npx.cmd wrangler secret put APP_TOKEN
npm.cmd run deploy
```

Nhập secrets qua prompt Wrangler, không đặt trong câu lệnh hay chat. Migration remote phải thành công trước khi deploy. URL chỉ được xác nhận sau khi Wrangler trả về kết quả deploy thực tế. Build là Wrangler dry-run, giao diện HTML/CSS/JS không cần bundler.

## API riêng của workspace

Mọi endpoint yêu cầu `Authorization: Bearer <APP_TOKEN>`; phản hồi API dùng `Cache-Control: no-store`.

| Method | Endpoint | Chức năng |
| --- | --- | --- |
| POST | `/api/jobs` | JSON `{ "url": "https://example.com" }`, trả HTTP 202 và ID tác vụ |
| GET | `/api/jobs` | 20 tác vụ gần nhất |
| GET | `/api/jobs/:id` | Kiểm tra WaterCrawl, lưu kết quả nếu xong, trả trạng thái |
| GET | `/api/pages` | 50 trang gần nhất và tổng số trang/ký tự |
| GET | `/api/pages/:id` | Nội dung Markdown và metadata đã lưu |

## Phạm vi và giới hạn

- Một workspace riêng với khóa dùng chung, chưa có tài khoản nhiều người. Người giữ APP_TOKEN xem được toàn bộ nội dung trong database này. Giao diện không giả lập đăng ký, credits hoặc GPT-4o vì luồng hiện tại không dùng các tính năng đó.
- Mỗi tác vụ lấy một trang; tối đa 5 tác vụ chờ đồng thời; hết hạn sau 20 phút. Chưa có hàng đợi crawl cả website hoặc lịch crawl lại.
- Chỉ nhận URL HTTP(S) với tên miền công khai, chặn IP literal và hostname nội bộ phổ biến. **WaterCrawl self-host cũng phải chặn IP riêng sau DNS resolution và mỗi redirect**; kiểm tra hostname ở Worker không thay thế chống SSRF tại crawler.
- Nội dung Markdown + metadata giới hạn 1,5 MB để giữ khoảng trống dưới giới hạn row D1. Không lưu HTML, ảnh hoặc tệp đính kèm. Với nội dung lớn hơn, cần bổ sung R2.
- Lỗi đọc kết quả hoặc ghi D1 giữ tác vụ pending để lần kiểm tra sau thử lại. Không tự gửi lại POST tạo crawl khi lỗi mạng, để tránh phát sinh crawl tính phí trùng. Nếu upstream đã nhận POST nhưng kết nối bị ngắt trước khi lưu UUID, cần kiểm tra WaterCrawl dashboard trước khi thử lại.
- Video nền dùng URL tham chiếu của bạn và font Google Fonts. Khi video không tải hoặc người dùng bật giảm chuyển động, nền gradient vẫn hoạt động. Fade dùng requestAnimationFrame 250ms, fade out ở 0,55 giây cuối, restart sau 100ms, không dùng CSS transition.

Tham khảo chính thức: [Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/), [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
