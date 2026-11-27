---
name: pccc-bachkhoa-cad-standards
description: Complete CAD Drafting Standards of CTY TNHH CƠ ĐIỆN LẠNH VÀ PCCC BÁCH KHOA. Covers exact layer configurations, color mapping, linetypes, block library symbols, text typography, dimensioning styles, sheet numbering (BC-xx báo cháy mặt bằng/trần thô, CS-xx chiếu sáng sự cố, CC-xx chữa cháy, EX-xx/EXR-xx thoát nạn, CT-xx chi tiết), and Bill of Quantities (BoQ) schedules.
---

# QUY CHUẨN THỂ HIỆN BẢN VẼ CAD - CTY PCCC BÁCH KHOA

Tài liệu chi tiết quy định quy chuẩn bản vẽ AutoCAD của **Công ty TNHH Cơ Điện Lạnh và PCCC Bách Khoa**. Mọi bản vẽ PCCC xuất xưởng đều phải chuẩn hóa theo các thông số sau:

---

## 1. BẢNG MÃ BẢN VẼ HỒ SƠ THIẾT KẾ (SHEET NUMBERING — THE REAL SERIES)

Bộ hồ sơ PCCC thật của **CTY PCCC BÁCH KHOA** không phải một chuỗi 5 bản vẽ cố định — nó gồm
**một chuỗi bản vẽ theo từng tầng/hạng mục**. Hai mẫu thực tế: SUNLAND 20-10-2026 (**76 bản vẽ**),
NHÀ MÁY MAY QUẢNG HƯNG (~**70 bản vẽ**). Mỗi hạng mục bắt đầu bằng **BIA** (bìa phân cách) rồi tới
mặt bằng từng tầng/hầm/mái, mặt cắt A-A, sơ đồ nguyên lý, chi tiết lắp đặt và bảng thống kê vật tư.

| Prefix | Hạng mục | Ví dụ (SUNLAND 76 Sheet) |
|---|---|---|
| `BIA` / `BI A` | Bìa hồ sơ + Bìa ký + Thống kê vật tư + Danh mục bản vẽ | BIA-01..04 |
| `BC-xx` | Báo cháy tự động — mặt bằng từng tầng/hầm/mái | BC-01 ( tầng hầm)…BC-09 (sân thượng) |
| `BC-10..18` | Báo cháy trần thô — mặt bằng từng tầng + sơ đồ nguyên lý | BC-10…17 (trần thô) + BC-18 (sơ đồ nguyên lý) |
| `CS-xx` | Chiếu sáng sự cố — mặt bằng từng tầng + sơ đồ nguyên lý + bảng tính nguồn điện | CS-01…09 + CS-10 (sơ đồ nguyên lý) + CS-11 (bảng tính nguồn) |
| `CC-xx` | Chữa cháy tự động — mặt bằng từng tầng | CC-01…09 |
| `CC-10..21` | Chữa cháy vách tường — mặt bằng từng tầng + thuyết minh + bảng tính + sơ đồ nguyên lý | CC-10…18 + CC-19 (thuyết minh) + CC-20 (bảng tính) + CC-21 (sơ đồ nguyên lý) |
| `EX-xx` / `EXR-xx` | Chỉ dẫn thoát nạn — mặt bằng từng tầng (2 dãy) | EX-01…09 + EXR-01…07 |
| `CT-xx` | Chi tiết lắp đặt | CT-01…06 |

**Quy tắc số liệu:**
- Số bản vẽ = (Số tầng/hầm/mái) × (số hạng mục áp dụng) + bìa/danh mục/vật tư. Không dùng chuỗi cố định BC-01…04 cho các dự án nhiều tầng.
- Mỗi tầng phải có **một mặt bằng BC-xx riêng**; mặt bằng mái/sân thượng dùng mã tầng tiếp theo.
- Bảng ký hiệu (legend) + Bảng ghi chú kỹ thuật + **BoQ (6 cột, xem mục 4)** đặt ở góc dưới bên phải mỗi tờ hoặc riêng tờ cuối hạng mục — không đè lên mặt bằng kiến trúc.
- Khung tên A3 chuẩn kèm mã bản vẽ chính xác ghi trên khung (tên dự án, hạng mục, tầng, mã bản vẽ, tỷ lệ).

---

## 2. QUY CHUẨN LAYER & MÀU SẮC (CAD LAYERS SPECIFICATION)

| Tên Layer | Màu (ACI) | Kiểu đường (Linetype) | Chiều dày nét (Lineweight) | Mục đích sử dụng |
| :--- | :---: | :---: | :---: | :--- |
| `FA-Equipment` | 1 (Red) | Continuous | 0.35 mm | Ký hiệu thiết bị báo cháy (Đầu báo, nút ấn, chuông còi, EOL) |
| `2x1.0mm` | 1 (Red) | Continuous | 0.30 mm | Tuyến cáp tín hiệu loop báo cháy (2x1.0mm2 luồn ống PVC D20) |
| `2x1.5mm` | 2 (Yellow) | Continuous | 0.30 mm | Tuyến cáp nguồn cấp chuông còi / module (2x1.5mm2) |
| `Dây báo cháy` | 4 (Cyan) | Continuous | 0.25 mm | Tuyến cáp liên động, dây chiếu sáng sự cố |
| `DN 25` | 3 (Green) | Continuous | 0.25 mm | Ống thép chữa cháy nhánh 1 - 2 đầu phun |
| `DN 32` | 3 (Green) | Continuous | 0.30 mm | Ống thép chữa cháy nhánh 3 đầu phun |
| `DN 40` | 4 (Cyan) | Continuous | 0.35 mm | Ống thép chữa cháy nhánh 4 - 5 đầu phun |
| `DN 50` | 4 (Cyan) | Continuous | 0.40 mm | Ống thép chữa cháy nhánh 6 - 8 đầu phun |
| `DN 70` | 1 (Red) | Continuous | 0.50 mm | Ống chính phân phối Sprinkler / Riser tầng |
| `DN 100` | 1 (Red) | Continuous | 0.60 mm | Ống cấp chính từ trạm bơm / Ống đứng vách tường |
| `DN 125` / `DN 150` | 6 (Magenta) | Continuous | 0.70 mm | Ống góp trạm bơm chữa cháy |
| `FIRE EQUIP` | 1 (Red) | Continuous | 0.35 mm | Tủ chữa cháy vách tường, trụ chữa cháy ngoài nhà |
| `TEXT` | 7 (White) | Continuous | 0.18 mm | Chữ ghi chú, tiêu đề phòng, nhãn thiết bị |
| `2-GHICHU` | 2 (Yellow) | Continuous | 0.18 mm | Ghi chú kỹ thuật, hướng dẫn thi công |
| `00_KPL_dim` | 8 (Gray) | Continuous | 0.13 mm | Đường gióng kích thước (Dimension) |
| `KHUNG` | 7 (White) | Continuous | 0.50 mm | Khung bản vẽ A3 |

---

## 3. THƯ VIỆN BLOCK CHUẨN CỦA CTY PCCC BÁCH KHOA

```
├── DAU BAO KHOI - KHONG DIA CHI : Vòng tròn ngoài Ø460 kèm chữ S (Optical Smoke Detector)
├── DAU BAO NHIET                : Vòng tròn ngoài Ø460 kèm chữ H (Heat Detector)
├── NUT NHAN KHAN CAP            : Khung vuông 400x400 hatch sọc đỏ kèm chữ FIRE
├── CHUONG BAO CHAY              : Vòng tròn kép hatch nửa vòm (Horn/Strobe)
├── DIEN_TRO                     : Ký hiệu ziczac điện trở cuối tuyến (EOLR 4.7kΩ)
├── BOX NOI DAY FA               : Hình chữ nhật 500x300 chia đôi gạch chéo (Junction Box)
├── dp                           : Đầu phun Sprinkler tròn Ø240 kèm 4 tia deflector
├── họng 1 cửa                   : Tủ vách tường hình chữ nhật 650x450 hatch gạch chéo đỏ
├── tru cc3c                     : Trụ nước chữa cháy ngoài nhà 3 cửa (1xD100 + 2xD65)
├── van chan kem cong tac giam sat DN150 : Van cổng kèm công tắc giám sát OS&Y
├── VAN 1CHIEU                   : Van một chiều chữa cháy
├── EMERL                        : Đèn chiếu sáng sự cố 2 bóng đèn tròn LED
├── EX                           : Đèn EXIT chữ nhật chỉ hướng thoát nạn
├── ABC                          : Bình bột chữa cháy ABC 4kg (MFZ4)
└── KHUNG A3 ATT / KHUNGMAU      : Khung tên tiêu chuẩn khổ giấy A3 (420 x 297 mm)
```

---

## 4. QUY CÁCH TRÌNH BÀY BẢNG KÝ HIỆU & THỐNG KÊ VẬT TƯ (BoQ)

Bảng thống kê vật tư được bố trí ở phía bên phải bản vẽ, không chèn lên mặt bằng kiến trúc. Cấu trúc bảng gồm 6 cột:

| Cột | Tiêu đề | Chiều rộng chuẩn (tỷ lệ 1:100) | Nội dung |
| :---: | :--- | :---: | :--- |
| 1 | `STT` | 1000 mm | Số thứ tự (1, 2, 3...) |
| 2 | `KÝ HIỆU` | 1800 mm | Block CAD thu nhỏ (scale 0.8) |
| 3 | `TÊN THIẾT BỊ - QUY CÁCH` | 8000 mm | Tên gọi thiết bị, chủng loại, thông số kỹ thuật |
| 4 | `ĐVT` | 1200 mm | Đơn vị tính (Cái, Bộ, Mét, Cuộn) |
| 5 | `SỐ LƯỢNG` | 1500 mm | Số lượng thống kê thực tế trên mặt bằng |
| 6 | `GHI CHÚ` | 3500 mm | Vị trí lắp đặt, căn cứ tiêu chuẩn |

*Quy cách ô*:
- Chiều cao hàng tiêu chuẩn: $600\text{mm} - 700\text{mm}$.
- Text trong bảng: Chiều cao $250\text{mm}$, căn lề giữa (Middle Center) cho STT, Ký hiệu, ĐVT, Số lượng; căn lề trái (Middle Left) cho Tên thiết bị và Ghi chú.
