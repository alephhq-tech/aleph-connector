---
name: pccc-bachkhoa-cad-standards
description: Complete CAD Drafting Standards of CTY TNHH CƠ ĐIỆN LẠNH VÀ PCCC BÁCH KHOA. Covers exact layer configurations, color mapping, linetypes, block library symbols, text typography, dimensioning styles, sheet numbering (BC-xx, CC-xx, CSSC-xx, SĐTN-xx), and Bill of Quantities (BoQ) schedules.
---

# QUY CHUẨN THỂ HIỆN BẢN VẼ CAD - CTY PCCC BÁCH KHOA

Tài liệu chi tiết quy định quy chuẩn bản vẽ AutoCAD của **Công ty TNHH Cơ Điện Lạnh và PCCC Bách Khoa**. Mọi bản vẽ PCCC xuất xưởng đều phải chuẩn hóa theo các thông số sau:

---

## 1. BẢNG MÃ BẢN VẼ HỒ SƠ THIẾT KẾ (SHEET NUMBERING)

| STT | Ký hiệu Bản vẽ | Tên Bản vẽ | Khổ giấy | Ghi chú |
| :---: | :---: | :--- | :---: | :--- |
| **I** | **BÁO CHÁY TỰ ĐỘNG** | | | |
| 1 | `BC-01` | Mặt bằng bố trí báo cháy tầng hầm | A3 | Thang tỷ lệ 1/100 |
| 2 | `BC-02` | Mặt bằng bố trí báo cháy tầng 1 / trần mái | A3 | Thang tỷ lệ 1/100 |
| 3 | `BC-03` | Mặt bằng bố trí báo cháy tầng điển hình | A3 | Thang tỷ lệ 1/100 |
| 4 | `BC-04` | Sơ đồ nguyên lý hệ thống báo cháy | A3 | Sơ đồ khối / Riser |
| **II** | **CHIẾU SÁNG SỰ CỐ & THOÁT NẠN** | | | |
| 5 | `CSSC-01` | Mặt bằng đèn CSSC & Đèn EXIT | A3 | Đèn sự cố, đèn chỉ hướng |
| 6 | `CSSC-02` | Sơ đồ nguyên lý đèn CSSC & EXIT | A3 | Nguồn cấp tủ CSSC |
| 7 | `CSSC-03` | Chiếu sáng phương tiện chữa cháy | A3 | Chiếu sáng vị trí tủ / bình |
| **III** | **CHỮA CHÁY SPRINKLER TỰ ĐỘNG** | | | |
| 8 | `CC-01` | Mặt bằng bố trí đầu phun Sprinkler | A3 | Thang tỷ lệ 1/100 |
| 9 | `CC-02` | Sơ đồ nguyên lý bố trí Sprinkler | A3 | Sơ đồ không gian / Isometric |
| 10 | `CC-03` | Sơ đồ nguyên lý trạm bơm & cụm van PCCC | A3 | Bơm điện, diesel, bù áp |
| **IV** | **CHỮA CHÁY VÁCH TƯỜNG** | | | |
| 11 | `CC-04` | Mặt bằng chữa cháy vách tường | A3 | Vị trí hộp họng, lăng vòi |
| **V** | **SƠ ĐỒ THOÁT NẠN** | | | |
| 12 | `SĐTN-01` | Sơ đồ chỉ dẫn thoát nạn công trình | A3 | Vị trí "BẠN ĐANG Ở ĐÂY" |
| **VI** | **CHI TIẾT LẮP ĐẶT** | | | |
| 13 | `CT-01` | Chi tiết lắp đặt đầu phun, tủ PCCC | A3 | Chi tiết phóng to 1/20 |
| 14 | `CT-02` | Chi tiết lắp đặt chuông còi, nút ấn | A3 | Chi tiết phóng to 1/20 |
| 15 | `CT-03` | Chi tiết cụm van báo động Alarm Valve | A3 | Chi tiết phóng to 1/20 |

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
