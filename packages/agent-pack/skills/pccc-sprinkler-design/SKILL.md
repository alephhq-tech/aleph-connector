---
name: pccc-sprinkler-design
description: Design code-compliant automatic fire sprinkler systems per TCVN 7336:2021 and QCVN 06:2022/BXD. Determine hazard classification, calculate maximum head spacing and coverage areas, place upright or pendent heads, route hierarchical tree pipe networks (DN25 to DN150), and generate clean hydraulic calculation boundary notes without text collisions.
---

# THIẾT KẾ HỆ THỐNG CHỮA CHÁY SPRINKLER TỰ ĐỘNG (TCVN 7336:2021)

Hệ thống Chữa cháy tự động Sprinkler chịu sự điều chỉnh của tiêu chuẩn quốc gia **TCVN 7336:2021** ("Phòng cháy chữa cháy - Hệ thống chữa cháy tự động bằng nước, bọt - Yêu cầu thiết kế và lắp đặt").

---

## 1. PHÂN NHÓM NGUY CƠ CHÁY & THÔNG SỐ THIẾT KẾ

Theo TCVN 7336:2021 Điều 5 và Bảng 1, các công trình phổ biến được phân nhóm:

| Nhóm nguy cơ cháy | Loại công trình điển hình | Cường độ phun tối thiểu ($I$) | Diện tích bảo vệ tối đa 1 đầu phun ($S$) | Khoảng cách tối đa giữa 2 đầu phun | Thời gian phun tính toán |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Nhóm 1 (Nguy cơ thấp)** | Văn phòng, khách sạn, trường học, bệnh viện | $0.08\text{ l}/(\text{s}\cdot\text{m}^2)$ | $\le 12.0\text{ m}^2$ | $\le 4.0\text{ m}$ | $30\text{ phút}$ |
| **Nhóm 2 (Nguy cơ trung bình)** | **Gara ô tô ngầm**, trung tâm thương mại, nhà xưởng dệt may | $0.12\text{ l}/(\text{s}\cdot\text{m}^2)$ | $\le 9.0\text{ m}^2$ | $\le 4.0\text{ m}$ | $60\text{ phút}$ |
| **Nhóm 3 (Nguy cơ cao)** | Kho bao bì giấy, kho hóa chất, xưởng sơn | $0.24\text{ l}/(\text{s}\cdot\text{m}^2)$ | $\le 9.0\text{ m}^2$ | $\le 4.0\text{ m}$ | $60\text{ phút}$ |

*TCVN 7336:2021 Table 1 — all Groups 1–3 share the 4.0 m max head-to-head spacing; the
differences are density (I), calculated area (S = 60/120/120 m²), coverage per head (12.0/9.0/9.0 m²)
and discharge time. Min head-to-head spacing 1.5 m; head-to-wall ≤ 1.2 m (unprotected wall);
ceiling-deflector clearance 0.08–0.30 m; max protected height 20 m.*

---

## 2. QUY CÁCH ĐẦU PHUN SPRINKLER (`dp`)

1. **Nhiệt độ kích hoạt**:
   - Khu vực thông thường (nhiệt độ môi trường $\le 38^\circ\text{C}$): Dùng đầu phun nhiệt độ nổ bóng thủy tinh $68^\circ\text{C}$ (màu đỏ).
   - Khu vực bếp, phòng máy phát điện: Dùng đầu phun $93^\circ\text{C}$ (màu xanh lá) hoặc $141^\circ\text{C}$ (màu xanh dương).
2. **Kiểu lắp đặt**:
   - Trần có đóng thạch cao: Đầu phun hướng xuống (Pendent sprinkler) hoặc đầu phun âm trần (Concealed).
   - Trần bê tông hở / Gara không trần: Đầu phun hướng lên (Upright sprinkler) hoặc hướng xuống gắn nắp bảo vệ.
3. **Hệ số lưu lượng K**:
   - K=80 (hoặc K=5.6 GPM): Đầu phun tiêu chuẩn ren 1/2" DN15.
   - K=115 (hoặc K=8.0 GPM): Đầu phun lưu lượng lớn ren 3/4" DN20 cho gara ngầm và kho hàng.

---

## 3. PHÂN CẤP ĐƯỜNG KÍNH ĐƯỜNG ỐNG (PIPE SIZING HIERARCHY)

Mạng đường ống Sprinkler bắt buộc bố trí theo hình cây phân cấp (Tree Network). Kích thước ống được xác định theo số lượng đầu phun phụ trách (TCVN 7336 Bảng 4):

| Kích thước ống danh định | Ký hiệu Layer CAD | Số lượng đầu phun phụ trách tối đa |
| :---: | :---: | :---: |
| **DN 25** (1") | `DN 25` | 1 đến 2 đầu phun |
| **DN 32** (1 1/4") | `DN 32` | 3 đầu phun |
| **DN 40** (1 1/2") | `DN 40` | 4 đến 5 đầu phun |
| **DN 50** (2") | `DN 50` | 6 đến 8 đầu phun |
| **DN 70** / **DN 65** (2 1/2") | `DN 70` | 9 đến 16 đầu phun |
| **DN 100** (4") | `DN 100` | 17 đến 48 đầu phun (Cross-Main chính) |
| **DN 125** / **DN 150** (5"-6") | `DN 125` / `DN 150` | Trục đứng cấp nước từ trạm bơm |

---

## 4. NGUYÊN TẮC TRÁNH ĐÈ CHỮ VÙNG TÍNH THỦY LỰC (ZERO COLLISION)

Khi thể hiện vùng tính toán thủy lực bất lợi nhất:
1. Đóng khung hình chữ nhật bằng nét mảnh (layer `2-GHICHU`) bao quanh diện tích tính toán tối thiểu ($S = 90\text{ m}^2$ cho gara ngầm Nhóm 2).
2. **Vị trí đặt Text ghi chú**:
   - Đặt bên ngoài luồng xe chạy hoặc lùi về vùng lề trống, cách xa các đường kích thước và cao độ tối thiểu $500\text{mm}$.
   - Khối MText gồm các thông số:
     ```
     VÙNG TÍNH TOÁN THỦY LỰC BẤT LỢI NHẤT
     - Diện tích tính toán: S = 90 m² (TCVN 7336:2021)
     - Cường độ phun yêu cầu: I = 0.12 l/(s·m²)
     - Lưu lượng đầu phun chủ đạo: q = 1.17 l/s (P = 0.86 bar)
     - Tổng lưu lượng tính toán: Q = 10.8 l/s
     ```
   - CẤM viết rời rạc từng dòng text có cùng tọa độ insertion gây chồng chữ.
