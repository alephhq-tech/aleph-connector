---
name: aleph-pccc-master
description: Master orchestration skill for Vietnamese Fire Protection Engineering (PCCC). Analyzes architectural floor plans, determines project sub-systems (báo cháy tự động, chữa cháy sprinkler, họng nước vách tường, chiếu sáng sự cố & EXIT, bình chữa cháy), selects proper equipment and codes per TCVN 7568-14:2025, TCVN 7336:2021, TCVN 13456:2022, TCVN 3890:2023, and QCVN 06:2022/BXD, and coordinates CAD drafting adhering to CTY PCCC BÁCH KHOA standards.
---

# ALEPH PCCC MASTER: QUY TRÌNH THIẾT KẾ & ĐIỀU PHỐI HỒ SƠ PCCC

Kỹ năng điều phối tổng thể dành cho AI Agent khi tiếp nhận yêu cầu thiết kế PCCC từ người dùng. Kỹ năng này hướng dẫn Agent phân tích ý định, phân loại hạng mục công trình, bóc tách cấu trúc kiến trúc và điều phối bản vẽ theo đúng quy cách của **CTY PCCC BÁCH KHOA**.

---

## 1. CẤU TRÚC HỒ SƠ THIẾT KẾ THẬT (CHUỖI BẢN VẼ THẬT, KHÔNG PHẢI CHUỖI CỐ ĐỊNH)

Một bộ hồ sơ PCCC thật của **CTY PCCC BÁCH KHOA** gồm chuỗi các bản vẽ theo từng tầng/hạng mục (ví dụ: SUNLAND 20-10-2026 — 76 bản vẽ; NHÀ MÁY MAY QUẢNG HƯNG — ~70 bản vẽ):

```
[ BIA thông tin chung ] –> [ BC-xx mặt bằng từng tầng ] –> [ CS-xx chiếu sáng sự cố ] –> [ CC-xx chữa cháy ]
        |                       |                        |                        |
   Bìa + Bìa ký + VT + danh mục  Hầm + Tầng 1… mái     CS-01…11 nguồn điện      CC-01…21 vách tường
```

**Quy ước mã bản vẽ (theo mẫu thực tế):**

| Prefix | Hạng mục | Ví dụ (SUNLAND 76 Sheet) |
|---|---|---|
| `BIA` / `BI A` | Bìa hồ sơ + Bìa ký + Thống kê vật tư + Danh mục bản vẽ (thông tin chung) | BIA-01..04 |
| `BC-xx` | Báo cháy tự động — mặt bằng từng tầng/hầm/mái (II) | BC-01 (tầng hầm)…BC-09 (sân thượng) |
| `BC-10..18` | Báo cháy trần thô — mặt bằng từng tầng + sơ đồ nguyên lý | BC-10…17 (trần thô) + BC-18 (sơ đồ nguyên lý) |
| `CS-xx` | Chiếu sáng sự cố — mặt bằng từng tầng + sơ đồ nguyên lý + bảng tính nguồn điện | CS-01…09 + CS-10 (sơ đồ nguyên lý) + CS-11 (bảng tính nguồn) |
| `CC-xx` | Chữa cháy tự động — mặt bằng từng tầng (V) | CC-01…09 |
| `CC-10..21` | Chữa cháy vách tường — mặt bằng từng tầng + thuyết minh + bảng tính + sơ đồ nguyên lý (VI) | CC-10…18 + CC-19 (thuyết minh) + CC-20 (bảng tính) + CC-21 (sơ đồ nguyên lý) |
| `EX-xx` / `EXR-xx` | Chỉ dẫn thoát nạn — mặt bằng từng tầng (VII–VIII) | EX-01…09 + EXR-01…07 |
| `CT-xx` | Chi tiết lắp đặt (IX) | CT-01…06 |

**Bắt buộc khi hoàn thành một hạng mục:** Agent PHẢI tạo được bộ hồ sơ đủ thành phần — không được dừng lại ở "một bản vẽ". Mỗi tầng/hạng mục phải có: (1) Mặt bằng bố trí thiết bị, (2) Mặt cắt A-A (nếu có), (3) Sơ đồ nguyên lý (nếu báo cháy), (4) Chi tiết lắp đặt (nếu có), (5) Bảng ký hiệu & ghi chú kỹ thuật, (6) Khung tên A3 chuẩn với mã bản vẽ chính xác.

---

## 2. QUY TRÌNH 4 BƯỚC CỦA KỸ SƯ PCCC

### Bước 1: Tiếp nhận yêu cầu & Nhận diện Hạng mục
- "báo cháy", "đầu báo", "chuông còi", "nút ấn": Kích hoạt **Hệ thống Báo cháy tự động** (`BC`).
- "sprinkler", "đầu phun", "chữa cháy tự động": Kích hoạt **Hệ thống Chữa cháy Sprinkler** (`CC`).
- "họng vách tường", "cuộn vòi", "tủ pccc vách tường", "trụ chữa cháy": Kích hoạt **Hệ thống Họng nước chữa cháy vách tường** (`CC`).
- "đèn sự cố", "đèn exit", "thoát nạn", "chiếu sáng sự cố": Kích hoạt **Hệ thống Chiếu sáng sự cố & Chỉ dẫn thoát nạn** (`CS` / `EX`).
- "bình chữa cháy", "bình bột", "bình co2": Kích hoạt **Bố trí Phương tiện chữa cháy ban đầu**.

*Lưu ý cốt tử*: Nếu người dùng yêu cầu làm một hạng mục cụ thể (ví dụ: "thiết kế báo cháy tầng hầm"), TUYỆT ĐỐI KHÔNG vẽ chèn các thiết bị của hạng mục khác (như đường ống sprinkler hoặc đầu phun nước) lên bản vẽ đó.

### Bước 2: Giải phẫu Mặt bằng Kiến trúc (Architectural Spatial Analysis)
Agent phải đọc và nhận diện:
1. **Loại công năng sàn**:
   - Gara ngầm (Basement Parking): Chứa nhiều khí thải CO/CO2 từ phương tiện giao thông -> BẮT BUỘC dùng **Đầu báo nhiệt gia tăng (Rate-of-Rise Heat)**. CẤM dùng đầu báo khói quang.
   - Sảnh thang máy, sảnh chính, hành lang, phòng bảo vệ, văn phòng: Dùng **Đầu báo khói quang kiểu điểm (Optical Smoke)**.
2. **Hệ thống trục kết cấu (Columns & Beams)**:
   - Dây tín hiệu và ống chữa cháy phải chạy bám theo các trục dầm chính (`beam highways`), không đi chéo cắt ngang qua giữa ô sàn.
   - **Dầm sâu > 0.3 m**: heat spacing giảm **30%** (5.9.2.1.5); smoke dùng quy tắc lắp đặt theo ô (5.9.1.1.6) — ô $< 4\text{ m}^2$ (trần 2–4 m) → dưới mặt dầm; ô $\ge 4\text{ m}^2$ → ≥ 1 đầu báo mỗi ô; mỗi ô giữa các dầm sâu được coi là phòng riêng, phải bảo vệ riêng.
3. **Vùng cấm (Obstacles & Forbidden Zones)**:
   - Giếng thang máy: Cabin di chuyển bên trong giếng thang; CẤM đặt đầu báo, CẤM đi dây/ống xuyên qua giếng thang.
   - Ram dốc xe: Khoảng tĩnh không cho xe cộ; dây/ống phải né dầm biên trên cao, không đặt thiết bị thấp.
   - Lối thoát nạn & Cửa buồng thang bộ: Vị trí đặt Hộp nút ấn khẩn (MCP) và Chuông đèn kết hợp ở cao độ $Z = 1.4\text{m}$ (ngay bên cạnh cửa buồng thang).
   - Không gian trống nửa hình cầu bán kính 0.6 m xung quanh mặt trước hộp nút ấn (5.10.4).

### Bước 3: Tiêu chuẩn Kỹ thuật Bắt buộc
- **Báo cháy**: Tuân thủ **TCVN 7568-14:2025** (thay thế TCVN 5738:2021). Bán kính bảo vệ đầu báo nhiệt $R \le 5.1\text{m}$, đầu báo khói $R \le 7.2\text{m}$; khoảng cách giữa các đầu báo ≤ 7.2 m (nhiệt) / ≤ 10.2 m (khói); hàng ngoài tường 3.6 m (nhiệt) / 5.1 m (khói); MCP ở $Z = 1.4 \pm 0.2\text{ m}$; chuông ≥ 65 dBA (khu vực ngủ ≥ 75 dBA), không quá 105 dBA; mạch dây Daisy-Chain nối tiếp khép kín hoặc kết thúc EOLR 4.7kΩ.
- **Sprinkler**: Tuân thủ **TCVN 7336:2021**. Khoảng cách đầu phun **≤ 4.0 m** (cả 3 nhóm 1/2/3); diện tích bảo vệ ≤ 12.0/9.0/9.0 m²/đầu phun; khoảng cách tối thiểu đầu phun 1.5 m; đầu phun cách trần 0.08–0.30 m; cách tường K0/K1 ≤ 2.0 m (nửa spacing), cách tường K2/K3 và loại khác ≤ 1.2 m; chiều cao tối đa bảo vệ 20 m. Mạng ống phân cấp DN 100 → DN 25 (Bảng 4, TCVN 7336).
- **Thoát nạn**: Tuân thủ **TCVN 13456:2022**. Đèn EXIT tại mọi cửa thoát nạn; đèn chiếu sáng sự cố dọc hành lang và cầu thang với độ rọi tối thiểu $\ge 1.0\text{ lux}$ trên mặt sàn.
- **Họng nước vách tường**: Tuân thủ **TCVN 3890:2023** & QCVN 06:2022/BXD. Họng tường cách góc $\ge 0.5\text{ m}$; cuộn vòi trong tủ có vạch chia.
- **Bình chữa cháy**: Tuân thủ QCVN 06:2022/BXD. Bình treo cao $0.8\text{–}1.5\text{ m}$ so với mặt sàn, trong phạm vi hoạt động $\le 30\text{ m}$.

### Bước 4: Xuất Bản vẽ Chuẩn CTY PCCC Bách Khoa
1. Sử dụng đúng Block thư viện: `DAU BAO KHOI - KHONG DIA CHI`, `DAU BAO NHIET`, `NUT NHAN KHAN CAP`, `CHUONG BAO CHAY`, `DIEN_TRO`, `BOX NOI DAY FA`, `MODULE ZM`, `CM MODULE`, `dp`, `họng 1 cửa`, `EMERL`, `EX`, `ABC`, `tru cc3c`.
2. Sử dụng đúng Layer: `FA-Equipment`, `2x1.0mm`, `2x1.5mm`, `DN 25` đến `DN 150`, `TEXT`, `2-GHICHU`.
3. Tuyệt đối chống đè chữ: Text ghi chú, cao độ, kích thước không được đè lên nhau; kiểm tra bằng `drawing.check` (overlap + outside-bounds) trước khi hoàn thành.
4. Xuất **Hai bảng**: (a) Bảng ký hiệu & ghi chú (6 cột: STT 1000 / KÝ HIỆU 1800 / TÊN 8000 / ĐVT 1200 / SỐ LƯỢNG 1500 / GHI CHÚ 3500 mm; hàng 600–700 mm; chữ 250 mm) đặt ở góc phải mỗi tờ — không chèn mặt bằng; (b) Bảng thống kê vật liệu theo tầng (riêng 1 tờ A3): banner tiêu đề `BẢNG THỐNG KÊ VẬT LIỆU - TÒA NHÀ <TÊN DỰ ÁN>`, các mục lớn (I — HỆ THỐNG BÁO CHÁY / II — CHIẾU SÁNG SỰ CỐ & THOÁT NẠN / III — HỆ THỐNG CHỮA CHÁY) với băng xanh dương, cột `STT | Danh mục | ĐVT | Hầm | T1…T7 | Tum | Tổng cộng`, Tổng cộng = tổng cột tầng của mỗi dòng (xem `pccc-bachkhoa-cad-standards` §4.2).
5. Gán Khung tên A3 chuẩn với mã bản vẽ chính xác (`BC-01`, `CC-01`, `CS-01`, `EX-01`…) và ghi rõ tên dự án + hạng mục + tầng + mã bản vẽ + tỷ lệ.

---

## 3. CHECKLIST HOÀN THÀNH BẢN VẼ (bắt buộc kiểm tra trước khi báo kết quả)

1. [ ] **Hạng mục đúng**: chỉ vẽ thiết bị của hạng mục được yêu cầu; không chèn thiết bị hạng mục khác.
2. [ ] **Đủ thành phần**: mặt bằng + (mặt cắt + sơ đồ nguyên lý + chi tiết nếu hạng mục yêu cầu) + bảng ký hiệu/ghi chú + khung tên A3.
3. [ ] **Đúng tiêu chuẩn**: spacing đầu báo (5.1/7.2 m nhiệt, 7.2/10.2 m khói), spacing đầu phun (4.0 m), độ rọi sự cố (≥ 1.0 lux), Z nút ấn (1.4 ± 0.2 m, khoảng trống nửa hình cầu 0.6 m), chuông ≥ 65 dBA (ngủ ≥ 75 dBA), không quá 105 dBA.
4. [ ] **Vị trí đúng**: đầu báo/đèn không nằm trong giếng thang, không trong ram dốc, không che lấp bởi dầm sâu > 0.3 m; MCP/chuông ở vị trí gần cửa buồng thang.
5. [ ] **Đúng lớp & Block**: mọi thiết bị dùng Block thư viện đúng (không gõ chữ tự vẽ); đường dây đi trực giao bám dầm, EOLR ở cuối loop.
6. [ ] **Chưa đè chữ**: đã kiểm tra `drawing.check` cho toàn bản vẽ — 0 overlap/out-of-bounds mới báo "xong".
7. [ ] **Ghi BOQ & ghi chú**: bảng vật tư + bảng ký hiệu đã xuất trong cùng tờ bản vẽ cuối cùng của hạng mục.
