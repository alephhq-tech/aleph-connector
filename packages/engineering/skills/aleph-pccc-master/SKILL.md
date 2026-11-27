---
name: aleph-pccc-master
description: Master orchestration skill for Vietnamese Fire Protection Engineering (PCCC). Analyzes architectural floor plans, determines project sub-systems (báo cháy tự động, chữa cháy sprinkler, họng nước vách tường, chiếu sáng sự cố & EXIT, bình chữa cháy), selects proper equipment and codes per TCVN 7568-14:2025, TCVN 7336:2021, TCVN 13456:2022, TCVN 3890:2023, and QCVN 06:2022/BXD, and coordinates CAD drafting adhering to CTY PCCC BÁCH KHOA standards.
---

# ALEPH PCCC MASTER: QUY TRÌNH THIẾT KẾ & ĐIỀU PHỐI HỒ SƠ PCCC

Kỹ năng điều phối tổng thể dành cho AI Agent khi tiếp nhận yêu cầu thiết kế PCCC từ người dùng. Kỹ năng này hướng dẫn Agent phân tích ý định, phân loại hạng mục công trình, bóc tách cấu trúc kiến trúc và điều phối bản vẽ theo đúng quy cách của **CTY PCCC BÁCH KHOA**.

---

## 1. CẤU TRÚC HỒ SƠ THIẾT KẾ 5 BẢN VẼ CHUẨN KỸ SƯ (CHUỖI BẢN VẼ BÁCH KHOA)

Khi nhận lệnh thiết kế hoàn chỉnh một hạng mục PCCC (ví dụ Báo cháy tự động), kỹ sư Bách Khoa lập một bộ hồ sơ gồm chuỗi các bản vẽ đặt dàn ngang trên Model space (bước nhảy $\Delta X = 70,000\text{ mm}$):

```
[ BÌA HẠNG MỤC ] ---> [ BẢN VẼ BC-01 ] ---> [ BẢN VẼ BC-02 ] ---> [ BẢN VẼ BC-03 ] ---> [ BẢN VẼ BC-04 ]
(Tờ phân cách)         (Mặt bằng Hầm/T1)      (Mặt bằng Điển hình)    (Mặt cắt A-A)         (Sơ đồ Nguyên lý)
```

1. **Tờ bìa phân cách Hạng mục**: Khung viền A3 kép màu xanh lá / vàng ghi hoa: `HẠNG MỤC: BÁO CHÁY TỰ ĐỘNG`.
2. **Bản vẽ `BC-01` (Mặt bằng bố trí báo cháy tầng hầm / Tầng 1)**:
   - Thể hiện vị trí Hộp nối dây (`BOX NOI DAY FA`), Module ZM/CM tại trục kỹ thuật.
   - Đầu báo nhiệt gia tăng (`DAU BAO NHIET`) trong gara ngầm; đầu báo khói quang (`DAU BAO KHOI - KHONG DIA CHI`) trong sảnh/văn phòng.
   - Hộp nút ấn khẩn (`NUT NHAN KHAN CAP`) và Chuông còi (`CHUONG BAO CHAY`) tại cửa vào buồng thang bộ.
   - Tuyến dây loop trực giao bám dầm `2x1.0mm`, kết thúc tại Điện trở cuối tuyến (`DIEN_TRO`).
   - Đường kích thước khoảng cách đầu báo trên layer `00_KPL_dim`.
   - Bảng ký hiệu thiết bị & Bảng ghi chú kỹ thuật đặt ngay ngắn ở góc dưới bên phải hoặc lề khung tên.
3. **Bản vẽ `BC-02` (Mặt bằng bố trí báo cháy tầng điển hình / Trần mái)**:
   - Bố trí đầu báo khói bảo vệ hành lang và từng phòng chức năng.
4. **Bản vẽ `BC-03` (Mặt cắt công trình A-A)**:
   - Thể hiện cao độ lắp đặt đầu báo, chuông còi, nút ấn, đèn báo phòng trên mặt đứng và trần nhà.
5. **Bản vẽ `BC-04` (Sơ đồ nguyên lý hệ thống báo cháy - Riser Diagram)**:
   - Sơ đồ khối thể hiện Tủ trung tâm FACP, trục cáp riser liên tầng, module, chuông đèn và bảng thông số kỹ thuật.

---

## 2. QUY TRÌNH 4 BƯỚC CỦA KỸ SƯ PCCC

### Bước 1: Tiếp nhận yêu cầu & Nhận diện Hạng mục
- "báo cháy", "đầu báo", "chuông còi", "nút ấn": Kích hoạt **Hệ thống Báo cháy tự động** (`BC`).
- "sprinkler", "đầu phun", "chữa cháy tự động": Kích hoạt **Hệ thống Chữa cháy Sprinkler** (`CC`).
- "họng vách tường", "cuộn vòi", "tủ pccc vách tường", "trụ chữa cháy": Kích hoạt **Hệ thống Họng nước chữa cháy vách tường** (`CC`).
- "đèn sự cố", "đèn exit", "thoát nạn", "chiếu sáng sự cố": Kích hoạt **Hệ thống Chiếu sáng sự cố & Chỉ dẫn thoát nạn** (`CSSC`).
- "bình chữa cháy", "bình bột", "bình co2": Kích hoạt **Bố trí Phương tiện chữa cháy ban đầu**.

*Lưu ý cốt tử*: Nếu người dùng yêu cầu làm một hạng mục cụ thể (ví dụ: "thiết kế báo cháy tầng hầm"), TUYỆT ĐỐI KHÔNG vẽ chèn các thiết bị của hạng mục khác (như đường ống sprinkler hoặc đầu phun nước) lên bản vẽ đó.

### Bước 2: Giải phẫu Mặt bằng Kiến trúc (Architectural Spatial Analysis)
Agent phải đọc và nhận diện:
1. **Loại công năng sàn**:
   - Gara ngầm (Basement Parking): Chứa nhiều khí thải CO/CO2 từ phương tiện giao thông -> BẮT BUỘC dùng **Đầu báo nhiệt gia tăng (Rate-of-Rise Heat)**. CẤM dùng đầu báo khói quang.
   - Sảnh thang máy, sảnh chính, hành lang, phòng bảo vệ, văn phòng: Dùng **Đầu báo khói quang kiểu điểm (Optical Smoke)**.
2. **Hệ thống trục kết cấu (Columns & Beams)**:
   - Dây tín hiệu và ống chữa cháy phải chạy bám theo các trục dầm chính (`beam highways`), không đi chéo cắt ngang qua giữa ô sàn.
3. **Vùng cấm (Obstacles & Forbidden Zones)**:
   - Giếng thang máy: Cabin di chuyển bên trong giếng thang; CẤM đặt đầu báo, CẤM đi dây/ống xuyên qua giếng thang.
   - Ram dốc xe: Khoảng tĩnh không cho xe cộ; dây/ống phải né dầm biên trên cao, không đặt thiết bị thấp.
   - Lối thoát nạn & Cửa buồng thang bộ: Vị trí đặt Hộp nút ấn khẩn (MCP) và Chuông đèn kết hợp ở cao độ $Z = 1.4\text{m}$ (ngay bên cạnh cửa buồng thang).

### Bước 3: Tiêu chuẩn Kỹ thuật Bắt buộc
- **Báo cháy**: Tuân thủ **TCVN 7568-14:2025** (thay thế TCVN 5738:2021). Bán kính bảo vệ đầu báo nhiệt $R \le 5.1\text{m}$, đầu báo khói $R \le 7.2\text{m}$. Mạch dây Daisy-Chain nối tiếp khép kín hoặc kết thúc bằng điện trở cuối tuyến EOLR 4.7kΩ.
- **Sprinkler**: Tuân thủ **TCVN 7336:2021**. Khoảng cách đầu phun $\le 3.0\text{m} - 3.6\text{m}$, diện tích bảo vệ $\le 9\text{m}^2 - 12\text{m}^2$/đầu phun tùy nhóm nguy cơ cháy. Mạng ống phân cấp từ `DN 100` xuống `DN 25`.
- **Thoát nạn**: Tuân thủ **TCVN 13456:2022**. Đèn EXIT tại mọi cửa thoát nạn; đèn chiếu sáng sự cố dọc hành lang và cầu thang với độ rọi tối thiểu $\ge 1.0\text{ lux}$ trên mặt sàn.

### Bước 4: Xuất Bản vẽ Chuẩn CTY PCCC Bách Khoa
1. Sử dụng đúng Block thư viện: `DAU BAO KHOI - KHONG DIA CHI`, `DAU BAO NHIET`, `NUT NHAN KHAN CAP`, `CHUONG BAO CHAY`, `DIEN_TRO`, `BOX NOI DAY FA`, `MODULE ZM`, `CM MODULE`, `dp`, `họng 1 cửa`, `EMERL`, `EX`, `ABC`, `tru cc3c`.
2. Sử dụng đúng Layer: `FA-Equipment`, `2x1.0mm`, `2x1.5mm`, `DN 25` đến `DN 150`, `TEXT`, `2-GHICHU`.
3. Tuyệt đối chống đè chữ: Text ghi chú, cao độ, kích thước không được đè lên nhau.
4. Xuất Bảng ký hiệu & Thống kê vật tư (BoQ) riêng biệt, ngay ngắn ở góc phải bản vẽ.
5. Gán Khung tên A3 chuẩn với mã bản vẽ chính xác: `BC-01`, `CC-01`, `CSSC-01`...
