---
name: pccc-portable-extinguishers
description: Allocate portable fire extinguishers (powder ABC and gas CO2) per TCVN 3890:2023 and TCVN 7435 (ISO 11602). Calculate travel distance, extinguisher ratings, wall mounting heights, and CAD placement symbols.
---

# BỐ TRÍ PHƯƠNG TIỆN CHỮA CHÁY BAN ĐẦU - BÌNH CHỮA CHÁY (TCVN 3890:2023)

Bình chữa cháy xách tay và xe đẩy chữa cháy chịu sự điều chỉnh của tiêu chuẩn quốc gia **TCVN 3890:2023** và **TCVN 7435-1:2004 (ISO 11602-1)**.

---

## 1. PHÂN LOẠI BÌNH & CHẤT CHỮA CHÁY

1. **Bình bột chữa cháy ABC (`ABC`)**:
   - Ký hiệu: MFZ4 (4kg) hoặc MFZL4 (4kg bột tổng hợp ABC), MFZ8 (8kg).
   - Dập tắt được đám cháy loại A (chất rắn như gỗ, giấy), loại B (chất lỏng như xăng dầu), loại C (chất khí như gas, khí hóa lỏng) và thiết bị điện hạ thế.
   - Ứng dụng phổ biến nhất cho hành lang, văn phòng, nhà xưởng, gara xe.
2. **Bình khí CO2 (`MT3` / `MT5`)**:
   - Ký hiệu: MT3 (3kg khí CO2) hoặc MT5 (5kg khí CO2).
   - Hiệu quả cao với đám cháy thiết bị điện tử, phòng máy chủ (server), trạm biến áp, phòng điều khiển (không để lại cặn bột gây hỏng vi mạch điện tử).

---

## 2. KHOẢNG CÁCH DI CHUYỂN & MẬT ĐỘ BỐ TRÍ

Theo TCVN 3890:2023 Bảng 2:

| Mức độ nguy cơ cháy của khu vực | Khoảng cách di chuyển tối đa đến bình gần nhất | Định mức diện tích bảo vệ |
| :--- | :---: | :---: |
| **Nguy cơ cháy cao** (Gara ô tô, kho xăng dầu, xưởng sơn) | $\le 15\text{ m}$ | $50\text{ m}^2 / \text{bình}$ |
| **Nguy cơ cháy trung bình** (Văn phòng, thương mại, nhà xưởng dệt) | $\le 20\text{ m}$ | $75\text{ m}^2 / \text{bình}$ |
| **Nguy cơ cháy thấp** (Trường học, phòng học lý thuyết) | $\le 25\text{ m}$ | $100\text{ m}^2 / \text{bình}$ |

*Quy cách lắp đặt*:
- Đặt trong Hộp tủ chữa cháy kết hợp với cuộn vòi vách tường (`họng 1 cửa`).
- Treo trên giá đỡ tường hoặc đặt trên kệ bình đặt sàn:
  + Độ cao đỉnh bình chữa cháy: $\le 1.25\text{ m}$ so với mặt sàn.
  + Đặt tại vị trí thông thoáng, dễ thấy, cạnh cửa thoát hiểm, chân cầu thang bộ.

---

## 3. THỂ HIỆN BẢN VẼ CAD CHUẨN BÁCH KHOA
- Ký hiệu Block: `ABC` (Bình bột MFZ4), `VC` (Kệ/giá đỡ bình).
- Layer: `FIRE EQUIP` hoặc `FA-Equipment`.
- Đi kèm biển báo "BÌNH CHỮA CHÁY" dạ quang ở phía trên bình.
