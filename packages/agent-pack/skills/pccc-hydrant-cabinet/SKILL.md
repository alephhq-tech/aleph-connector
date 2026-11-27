---
name: pccc-hydrant-cabinet
description: Design wall-mounted indoor fire hydrant cabinets and outdoor fire hydrants per TCVN 3890:2023, TCVN 7336:2021, and QCVN 06:2022/BXD. Calculate water jet reach, spacing, riser sizing (DN65 to DN100), cabinet placement at exit stairs and corridors, Siamese connections, and Bách Khoa CAD block symbols.
---

# THIẾT KẾ HỆ THỐNG HỌNG NƯỚC CHỮA CHÁY VÁCH TƯỜNG (TCVN 3890:2023)

Hệ thống Họng nước chữa cháy vách tường là phương tiện chữa cháy tại chỗ bằng nước do lực lượng tại chỗ và lực lượng Cảnh sát PCCC chuyên nghiệp sử dụng.

---

## 1. TIÊU CHUẨN THIẾT KẾ & BỐ TRÍ

1. **Vị trí bố trí Tủ chữa cháy (`họng 1 cửa` / `họng 2 cửa`)**:
   - Bố trí tại các lối đi chung, sảnh đón, hành lang và **ngay trước cửa vào buồng thang bộ thoát hiểm**.
   - Không được bố trí trong phòng khóa kín hoặc vị trí bị cản trở bởi hàng hóa, phương tiện.
   - Cao độ lắp đặt: Tâm van góc chữa cháy cách mặt sàn hoàn thiện $1.25\text{ m} \pm 0.05\text{ m}$.
2. **Quy cách thiết bị trong tủ vách tường**:
   - Van góc chữa cháy DN50 hoặc DN65 ren ngoài hoặc ngàm nối tiêu chuẩn TCVN 5739.
   - Cuộn vòi chữa cháy tráng cao su D50 hoặc D65 dài $20\text{ m}$ chịu áp lực $1.6\text{ MPa}$.
   - Lăng phun chữa cháy đường kính miệng phun $\varnothing 13\text{ mm}$, $\varnothing 16\text{ mm}$ hoặc $\varnothing 19\text{ mm}$.
   - Ngăn dưới bố trí 02 bình chữa cháy xách tay (01 bình bột ABC 4kg + 01 bình khí CO2 3kg/5kg).
3. **Bán kính bảo vệ của một họng nước**:
   - Chiều dài cuộn vòi: $L = 20\text{ m}$.
   - Chiều dài tia nước đặc hiệu quả: $R_t = 6\text{ m} - 10\text{ m}$.
   - Bán kính bảo vệ thực tế tính toán: $R_{bv} = L \cdot k + R_t \approx 20 \times 0.8 + 6 = 22\text{ m}$.
   - Mọi điểm trong mặt bằng sàn phải được bảo vệ bởi ít nhất 01 đến 02 tia nước chữa cháy (tùy theo bậc chịu lửa và khối tích công trình).

---

## 2. HỆ THỐNG CẤP NƯỚC NGOÀI NHÀ & TRỤ CHỮA CHÁY

1. **Trụ chữa cháy ngoài nhà 3 cửa (`tru cc3c`)**:
   - Gồm 01 họng lớn DN100 (tiếp nước cho xe chữa cháy) và 02 họng nhỏ DN65 (cho lăng vòi).
   - Khoảng cách giữa các trụ dọc theo đường giao thông $\le 150\text{ m}$.
   - Trụ đặt cách mép đường xe chạy không quá $2.5\text{ m}$ và cách tường nhà không dưới $5\text{ m}$.
2. **Họng tiếp nước PCCC 2 cửa DN65 (Siamese Connection)**:
   - Đặt trên mặt đứng ngoài nhà tại vị trí xe chữa cháy dễ dàng tiếp cận.
   - Nối thẳng vào đường ống chính cấp nước chữa cháy trước van một chiều, cho phép xe bơm nước từ bên ngoài vào chi viện khi bể nước công trình cạn.

---

## 3. THỂ HIỆN BẢN VẼ CAD CHUẨN BÁCH KHOA
- Ký hiệu Block: `họng 1 cửa` (tủ vách tường), `tru cc3c` (trụ ngoài nhà), `1CHIEU` (van một chiều).
- Layer đường ống: `DN 70` (hoặc `DN 65`), `DN 100`, `FIRE EQUIP`.
- Ký hiệu bản vẽ: `CC-04` (Mặt bằng cấp nước chữa cháy vách tường).
