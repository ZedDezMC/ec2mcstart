# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Người chơi (Primary)**: Truy cập trang web để xem trạng thái server (EC2 & Minecraft), sao chép địa chỉ IP/Domain máy chủ, gửi yêu cầu khởi động server on-demand thông qua xác thực Captcha.
- **Admin / Quản trị viên**: Quản lý chi phí EC2, phê duyệt yêu cầu khởi động qua Discord Bot, chuyển đổi chế độ Dev/Normal mode, gửi lệnh RCON/SSM tới Minecraft console.

## Product Purpose
Tối ưu chi phí vận hành AWS EC2 cho server Minecraft bằng mô hình "On-Demand": Server chỉ chạy khi có nhu cầu chơi thực tế, tự động tắt sau khoảng thời gian trống không có người chơi (Auto-shutdown), đồng thời cung cấp giao diện Web thân thiện cho người chơi và công cụ điều khiển tiện lợi qua Discord cho Admin.

## Positioning
Giải pháp quản lý khởi động Minecraft Server EC2 On-Demand hoàn chỉnh: Tích hợp bảo vệ chống spam (Cloudflare Turnstile Captcha), tự động cập nhật Dynamic DNS (Cloudflare DNS A-Record), tích hợp PufferPanel/SSM/RCON và tương tác phê duyệt 2 chiều qua Discord Bot.

## Operating Context
- **Frontend**: Web Dashboard tĩnh (HTML5, Vanilla CSS, JS) hiển thị trạng thái realtime, nút sao chép IP/Port, nút yêu cầu khởi động và tích hợp Cloudflare Turnstile Captcha.
- **Backend**: Node.js / Express server kết nối AWS SDK (@aws-sdk/client-ec2, @aws-sdk/client-ssm), Cloudflare API (Turnstile & DNS), PufferPanel API, RCON client và Discord.js bot client.
- **VPS / Cloud**: Máy chủ AWS EC2 chạy Linux (systemd service, auto_shutdown daemon Python giám sát protocol Minecraft Server List Ping SLP để tự tắt khi không có người chơi).

## Capabilities and Constraints
- **Capabilities**:
  - Tra cứu và hiển thị trạng thái EC2 (stopped, pending, running, stopping) và Minecraft Server (Online/Offline, số người chơi, ping, MOTD).
  - Tự động đồng bộ Public IP mới của EC2 lên nhiều bản ghi Cloudflare DNS A-Record.
  - Hỗ trợ khởi động qua PufferPanel API hoặc lệnh SSM fallback.
  - Discord Bot tương tác: Thông báo, nút phê duyệt, lệnh RCON (!cmd, /cmd), nút chuyển chế độ Dev Mode / Normal Mode.
  - Tự động tắt máy (Auto-Shutdown Daemon) sau 30 phút không có người chơi (ở Normal Mode).
- **Constraints**:
  - Yêu cầu cấu hình biến môi trường AWS Credentials, Cloudflare Token/Zone ID, Discord Bot Token, Turnstile Keys.
  - DNS cập nhật cần `proxied: false` cho traffic TCP Minecraft.

## Brand Commitments
- Giao diện hiện đại, trực quan, hỗ trợ tiếng Việt, hiển thị rõ ràng trạng thái server và hướng dẫn kết nối máy chủ.

## Evidence on Hand
- Mã nguồn Express backend (`server.js`, `services/aws.js`, `services/cloudflare.js`, `services/discord.js`, `services/minecraft.js`, `services/pufferpanel.js`).
- Mã nguồn Frontend (`public/index.html`, `public/style.css`, `public/app.js`).
- Scripts tự động tắt VPS (`scripts/auto_shutdown.py`, `scripts/setup_autoshutdown.sh`).

## Product Principles
1. **Tiết kiệm và Tự động hóa**: Chỉ duy trì máy chủ khi có người chơi; tự động hóa luồng bật, cập nhật DNS, và tắt máy.
2. **Bảo mật và Kiểm soát**: Ngăn chặn spam bot qua Cloudflare Turnstile và cơ chế phê duyệt qua Discord.
3. **Trải nghiệm mượt mà**: Giao diện người dùng dễ hiểu, phản hồi trạng thái nhanh và hiển thị rõ ràng.
