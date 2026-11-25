# HRM – Hệ thống quản lý nhân sự (Node.js)

Backend: Node.js + NestJS (Express adapter) + TypeScript + SQLite (`node:sqlite`) + JWT + `bcryptjs`. Giao diện HTML/CSS/JavaScript hiện có nằm trong `public/`.

## Kiến trúc hiện tại

Ứng dụng đang ở **giai đoạn chuyển đổi sang SOA**, chưa phải SOA hoàn chỉnh:

- API Gateway chạy riêng trên cổng `PORT` (mặc định `3000`), phục vụ giao diện và chuyển tiếp nguyên trạng `/api/*` qua HTTP đến HRM Core Service.
- HRM Core Service chạy riêng trên `CORE_PORT` (mặc định `3100`) và sở hữu `DB_FILE`.
- Email/Notification Service chạy riêng trên `EMAIL_PORT` (mặc định `3200`), nhận lệnh email, thông báo và audit từ Core qua HTTP có xác thực nội bộ. Service sở hữu `EMAIL_DB_FILE`, chứa `email_dispatches`, `notifications` và `audit_logs`; không lưu nội dung email hay khóa ngoại sang bảng users. Đây là process duy nhất giữ cấu hình/credential SMTP.
- Config Service chạy riêng trên `CONFIG_PORT` (mặc định `3300`), sở hữu `CONFIG_DB_FILE` và lưu `settings`/`holidays`. Core gọi service qua HTTP; các nghiệp vụ đồng bộ trong Core đọc cache trong bộ nhớ, được nạp lúc khởi động và làm mới mỗi 30 giây.
- Identity Service chạy riêng trên `IDENTITY_PORT` (mặc định `3001`), sở hữu `IDENTITY_DB_FILE` và lưu `users`/`password_reset_tokens`. Chỉ Identity giữ `JWT_SECRET`, băm mật khẩu và phát hành token. Gateway gọi introspection qua HTTP, cache danh tính tối đa 30 giây rồi gắn các header đã xác thực khi chuyển tiếp request; Core không tự xác minh JWT.
- Gateway không truy cập database. Lệnh `npm start` khởi chạy cả năm process; các service kiểm tra health trước khi nhận lưu lượng.
- Gateway áp dụng timeout `GATEWAY_TIMEOUT_MS` (mặc định 5 giây); lỗi kết nối hoặc timeout trả HTTP 503 với mã `CORE_SERVICE_UNAVAILABLE`.
- Gateway áp dụng `IDENTITY_SERVICE_TIMEOUT_MS` (mặc định 3 giây); nếu Identity không khả dụng, request cần đăng nhập trả HTTP 503.
- Core áp dụng timeout `EMAIL_SERVICE_TIMEOUT_MS` cho email; các lệnh thông báo/audit dùng `NOTIFICATION_SERVICE_TIMEOUT_MS`, không chặn nghiệp vụ và ghi lỗi nếu gửi thất bại.
- Core áp dụng `CONFIG_SERVICE_TIMEOUT_MS` khi gọi Config Service. Nếu service tạm ngừng, các phép tính nghiệp vụ tiếp tục dùng bản cache cuối cùng; API cấu hình trả lỗi 503 khi không thể liên lạc với service.
- Gateway ghi đè `X-Forwarded-For` bằng địa chỉ client do Express xác định; Core chỉ tin header proxy từ loopback. Nếu đặt Nginx/Caddy trước Gateway, cấu hình `GATEWAY_TRUST_PROXY` theo đúng số hop hoặc subnet proxy tin cậy.
- Hợp đồng REST công khai được mô tả trong [`contracts/hrm-api.yaml`](./contracts/hrm-api.yaml) theo OpenAPI 3.1.
- Hợp đồng nội bộ Core → Email/Notification Service được mô tả trong [`contracts/email-service.openapi.yaml`](./contracts/email-service.openapi.yaml).
- Hợp đồng nội bộ Core → Config Service được mô tả trong [`contracts/config-service.openapi.yaml`](./contracts/config-service.openapi.yaml).
- Hợp đồng nội bộ Gateway/Core → Identity Service được mô tả trong [`contracts/identity-service.openapi.yaml`](./contracts/identity-service.openapi.yaml).
- Hợp đồng Identity → Core cho thao tác bảo đảm hồ sơ nhân viên được mô tả trong [`contracts/core-internal.openapi.yaml`](./contracts/core-internal.openapi.yaml).
- Khi khởi động, Core chuyển dữ liệu `notifications`/`audit_logs` cũ sang service theo batch, sau đó xóa hai bảng cũ khỏi `hrm.db`.
- Khi khởi động, Core cũng chuyển `settings`/`holidays` cũ sang `config.db`, rồi xóa các bảng đó khỏi `hrm.db`.
- Khi khởi động, Core chuyển `users`/`password_reset_tokens` cũ sang `identity.db` (giữ nguyên ID, password hash và token hash), rồi xóa các bảng đó khỏi `hrm.db`. Nếu chuyển dữ liệu thất bại, Core không khởi động để tránh mất dữ liệu.
- Tạo tài khoản mới gọi Core qua endpoint nội bộ để bảo đảm hồ sơ nhân viên tồn tại; các truy vấn users trong Leave, Overtime và Payroll gọi Identity API thay vì đọc DB của Identity.
- Nhân viên, tổ chức, chấm công, nghỉ phép, tăng ca, lương, báo cáo và lịch sử vẫn nằm trong Core, dùng chung `hrm.db`/`lib.js`; các miền này chưa có process/database riêng và tiếp tục cần tách.

## Chạy thử (5 phút)

```bash
npm install
cp .env.example .env        # rồi điền JWT_SECRET (xem hướng dẫn trong file)
npm start                   # tự biên dịch, chạy Gateway :3000, Identity :3001, Core :3100, Email :3200, Config :3300
npm test                    # chạy bộ kiểm thử API 
```

Trong môi trường production, đặt `INTERNAL_SERVICE_TOKEN` thành chuỗi ngẫu nhiên dài; không dùng token mặc định dành cho development. `npm run start:core`, `npm run start:gateway`, `npm run start:email`, `npm run start:config`, `npm run start:identity` khởi chạy từng process riêng nếu cần. Nếu chạy Core riêng, phải khởi động Identity, Email/Notification và Config Service trước.

Khi phát triển có hot reload, chạy `npm run dev:identity`, `npm run dev:email`, `npm run dev:config`, `npm run dev:core` và `npm run dev:gateway` trong năm terminal riêng.

Lần chạy đầu tiên, màn hình đăng nhập có nút tạo **tài khoản Admin đầu tiên**. Sau đó đăng ký tự do **đóng hẳn**: Admin tạo tài khoản ở tab "Tài khoản" (hệ thống sinh mật khẩu tạm, hiện một lần để chuyển cho nhân viên). HR tạo được tài khoản Nhân viên qua API `POST /api/users`; Admin tạo và đổi được mọi vai trò. Mật khẩu tối thiểu 8 ký tự. Tài khoản mới và tài khoản được Admin đặt lại mật khẩu phải đổi mật khẩu ở lần đăng nhập tiếp theo; khi nâng cấp hệ thống, các tài khoản hiện có cũng cần đổi mật khẩu một lần.

Để bật email, điền `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` và `APP_URL` vào `.env`. Nhà cung cấp email cần cho phép gửi SMTP (Gmail yêu cầu App Password; không dùng mật khẩu đăng nhập Gmail). `APP_URL` phải là URL trang web mà người dùng truy cập; môi trường thật bắt buộc dùng HTTPS (HTTP chỉ được chấp nhận cho localhost). Liên kết đặt lại có hiệu lực 30 phút, chỉ dùng một lần; token chỉ lưu dạng băm trong CSDL. Hệ thống cũng gửi email khi có đơn nghỉ/tăng ca cần xử lý, khi nhân viên nhận kết quả và khi phiếu lương được chốt (email không chứa số liệu lương). Nếu SMTP chưa cấu hình hoặc gửi email quy trình thất bại, lỗi được ghi vào log; thao tác nghiệp vụ vẫn được lưu.

## Chức năng
- Đăng ký, đăng nhập (giới hạn đăng nhập sai), đổi mật khẩu, khôi phục mật khẩu qua email, Admin cấp mật khẩu tạm ngẫu nhiên và bắt đổi ở lần đăng nhập tiếp theo
- Phân quyền Admin / HR / Quản lý / Nhân viên, kiểm tra ở phía server
- Phòng ban, chức danh
- Hồ sơ nhân viên: thêm, sửa, xóa, tìm kiếm, lọc phòng ban, phân trang, import và xuất CSV; kiểm tra email, số điện thoại (7–15 chữ số) và ngày vào làm
- Hồ sơ hiện chưa lưu ngày sinh nên chưa thể kiểm tra ngày sinh trong tương lai.
- **Tổng quan**: số liệu theo vai trò, check-in/out nhanh, phép còn lại; biểu đồ donut tình hình chấm công và biểu đồ cột quỹ lương
- **Chấm công**: check-in/out trên web, bảng công tháng, chi tiết từng ngày, HR sửa tay, import file máy chấm công, lọc theo phòng ban/tên/mã, phân trang và xuất CSV theo tháng
- **Nghỉ phép**: tạo đơn (cả ngày/nửa ngày), luồng duyệt Quản lý → HR, số dư phép năm, lọc trạng thái/tháng/phòng ban/tên/mã và phân trang, hủy đơn
- **Tăng ca**: đề nghị → Quản lý duyệt → HR xác nhận; chỉ giờ đã duyệt mới được đưa vào kỳ lương; lọc tháng/phòng ban/tên/mã và phân trang
- **Lương**: thiết lập lương từng người, kỳ lương, tính tự động từ bảng công và tăng ca đã duyệt, BHXH/BHYT/BHTN, thuế TNCN lũy tiến, thưởng/phạt/tạm ứng, chốt kỳ, phiếu lương, in/lưu PDF từ trình duyệt, xuất CSV; nhân viên xem lương tạm tính trong tháng và gửi yêu cầu ứng lương để HR/Admin duyệt
- **Báo cáo HR**: tổng hợp nhân sự, chấm công, nghỉ phép và chi phí lương theo tháng/phòng ban; xuất CSV
- **Lịch sử**: lưu các thay đổi hồ sơ và mức lương, ai thực hiện và thời điểm
- **Thông báo trong ứng dụng**: đơn nghỉ, tăng ca và phiếu lương được cập nhật theo luồng xử lý
- Menu tự điều chỉnh theo vai trò; thao tác gửi có trạng thái đang xử lý và thông báo toast, tránh bấm lặp
- Giao diện nghiệp vụ dùng font hệ thống, bảng và thẻ gọn, màu xanh tiết chế; không tải font ngoài từ CDN
- **Cấu hình**: giờ làm, ngày phép năm, hệ số tăng ca mẫu, tỷ lệ bảo hiểm, giảm trừ gia cảnh, biểu thuế, ngày lễ
- Nhật ký thao tác

## Quyền xem hồ sơ
| Vai trò | Xem | Sửa |
|---|---|---|
| Nhân viên | Hồ sơ của mình | Số điện thoại của mình |
| Quản lý | Phòng ban của mình | Số điện thoại của mình |
| HR | Tất cả | Tất cả |
| Admin | Tất cả + tài khoản | Tất cả |

## API chính
`POST /api/auth/login|change-password|forgot-password|reset-password`, `POST /api/auth/register` (chỉ tạo Admin đầu tiên), `GET /api/auth/status|me`,
`/api/departments`, `/api/positions`, `/api/employees` (+ `/import`),
`/api/users` (Admin xem/sửa/xóa; Admin và HR tạo mới), `/api/logs`, `/api/history`, `/api/notifications`,
`/api/attendance`, `/api/leave`, `/api/overtime`, `/api/payroll`, `/api/reports`, `/api/dashboard`, `/api/settings`, `/api/holidays`.

## Quy tắc tính toán (đọc kỹ trước khi dùng lương thật)
- **Công chuẩn**: các ngày thứ 2–6 trong tháng (thêm thứ 7 nếu bật ở Cấu hình), trừ ngày lễ. Phải nhập ngày lễ ở tab Cấu hình.
- **Công đi làm**: có check-in và check-out, làm từ 4 giờ = 1 công, dưới 4 giờ = 0,5 công. Thiếu check-out vẫn tính 1 công nhưng bị đánh dấu để HR sửa.
- **Vắng**: ngày làm việc đã qua, không đi làm, không có đơn nghỉ được duyệt.
- **Lương thực tế** = (lương cơ bản + phụ cấp) × (công đi làm + nghỉ phép có lương) ÷ công chuẩn.
- **Bảo hiểm** (mặc định NLĐ 10,5% = 8% + 1,5% + 1%): tính cố định hằng tháng trên mức lương đóng BH, có trần.
- **Thưởng** cộng vào tổng thu nhập và chịu thuế TNCN (không tính bảo hiểm, vì bảo hiểm tính theo mức lương đóng cố định). **Phạt** và **tạm ứng** trừ vào tiền thực nhận sau thuế, không làm giảm thu nhập tính thuế. Các khoản này nhập theo kỳ khi kỳ còn Nháp; thêm hoặc xóa xong phải bấm "Tính lương" lại. Hệ thống cảnh báo khi thực nhận bị âm. *Kế toán cần xác nhận cách xử lý thuế của thưởng và phạt này.*
- **Thực nhận** = thu nhập thực tế (gồm thưởng) − bảo hiểm − thuế TNCN − phạt − tạm ứng.
- **Lương tạm tính và ứng lương**: lương tạm tính trong tháng dựa trên công đã hoàn tất, phép có lương đã duyệt và tăng ca đã duyệt đến ngày hiện tại; chưa trừ thuế hoặc bảo hiểm. Hạn mức ứng minh họa là 50% lương tạm tính, trừ khoản ứng đã ghi nhận và yêu cầu còn chờ duyệt. HR/Admin duyệt yêu cầu sẽ tự tạo kỳ Nháp nếu cần và ghi khoản tạm ứng vào kỳ đó; phải tính lại kỳ để cập nhật phiếu lương. Kỳ đã chốt không nhận hoặc duyệt thêm yêu cầu ứng. Đây chỉ là ghi nhận nghiệp vụ, hệ thống không chuyển tiền thật; mức 50% là quy tắc demo, cần thay đổi theo chính sách doanh nghiệp khi sử dụng thực tế.
- **Tăng ca (mô hình đồ án)** = lương cơ bản ÷ công chuẩn trong tháng ÷ 8 giờ × số giờ đã được HR duyệt × hệ số cấu hình. Tiền tăng ca cộng vào thu nhập tính thuế; bảo hiểm vẫn tính theo mức lương đóng cố định. Hệ số mặc định 1,5 chỉ để minh họa, không khẳng định tuân thủ đầy đủ quy định theo ngày thường/ngày nghỉ/ngày lễ.
- **Thuế TNCN** = biểu lũy tiến 5 bậc trên (thu nhập − phụ cấp miễn thuế − bảo hiểm − giảm trừ bản thân − giảm trừ người phụ thuộc).
- Mặc định theo quy định hiệu lực từ 01/7/2026: giảm trừ 15,5 triệu / 6,2 triệu; biểu thuế 5/10/20/30/35%; trần BHXH-BHYT 50,6 triệu. **Kế toán cần kiểm tra lại các thông số này mỗi khi luật hoặc lương cơ sở thay đổi.**
- Phiếu lương lưu **bản chụp số liệu** lúc tính, nên đổi cấu hình sau này không làm thay đổi kỳ đã chốt. Chỉ Admin được mở khóa kỳ đã chốt.
- Kỳ lương đã chốt sẽ khóa sửa/import chấm công và tạo, duyệt, từ chối hoặc hủy đơn nghỉ/tăng ca có ngày thuộc kỳ đó. Nghỉ cả ngày đã duyệt cũng không thể check-in.
- Nhân viên đã có phiếu lương thì không xóa được hồ sơ, hãy chuyển trạng thái "Nghỉ việc".

## Triển khai thật
1. Đặt `NODE_ENV=production`, `JWT_SECRET` dài ngẫu nhiên (chỉ Identity nhận giá trị này) và `INTERNAL_SERVICE_TOKEN` dài ít nhất 32 byte.
2. **Bắt buộc chạy sau HTTPS** (Nginx/Caddy làm reverse proxy). Nếu dùng proxy, cấu hình `GATEWAY_TRUST_PROXY` đúng với proxy tin cậy để giới hạn đăng nhập tính đúng IP; không bật trust proxy rộng nếu chưa kiểm soát được nguồn kết nối.
3. Chạy bằng `npm start` hoặc `docker build -t hrm . && docker run -d -p 3000:3000 -v hrm-data:/app/data --env-file .env hrm`. Chỉ expose cổng Gateway ra ngoài; Core Service mặc định chỉ bind loopback.
4. **Sao lưu** toàn bộ thư mục `data/` hằng ngày (bao gồm `hrm.db`, `email.db`, `config.db` và `identity.db`), và thử khôi phục ít nhất một lần.

## Giới hạn hiện tại
- Upload và lưu file hợp đồng/giấy tờ, thông báo email (ngoại trừ email khôi phục mật khẩu)
- Ca làm việc linh hoạt, hệ số tăng ca riêng theo ngày thường/ngày nghỉ/ngày lễ, sơ đồ tổ chức dạng cây, lịch sử điều chuyển công tác
- Thuế: chưa xử lý trường hợp cá nhân không cư trú (20%) hoặc hợp đồng dưới 3 tháng (10%); chưa có quyết toán thuế cuối năm
- Phép năm chưa tính theo thâm niên và chưa cộng dồn sang năm sau; đơn nghỉ không được vắt qua năm
- Phiếu lương PDF hiện dùng chức năng in/lưu PDF của trình duyệt; chưa gửi phiếu lương qua email
