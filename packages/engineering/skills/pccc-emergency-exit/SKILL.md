---
name: pccc-emergency-exit
description: Design emergency lighting and exit signage systems per TCVN 13456:2022 and QCVN 06:2022/BXD. Determine emergency light (EMERL) placement along escape paths, illumination levels (minimum 1 lux), and Exit sign (EX / chidanthoatnan1huong) positions at doorways and direction changes, with wiring CU/FR 2x1.5mm2.
---

# THIẾT KẾ CHIẾU SÁNG SỰ CỐ & CHỈ DẪN THOÁT NẠN (TCVN 13456:2022)

Hệ thống Chiếu sáng sự cố (CSSC) và Đèn chỉ dẫn thoát nạn (EXIT) chịu sự điều chỉnh của tiêu chuẩn quốc gia **TCVN 13456:2022** ("Phòng cháy chữa cháy - Phương tiện chiếu sáng sự cố và chỉ dẫn thoát nạn - Yêu cầu thiết kế, lắp đặt").

---

## 1. YÊU CẦU ĐÈN CHỈ DẪN THOÁT NẠN (EXIT SIGN - `EX`)

1. **Vị trí bắt buộc lắp đặt**:
   - Ngay phía trên tất cả các cửa ra vào buồng thang bộ thoát nạn, cửa thoát ra hành lang chung, cửa ra ngoài nhà.
   - Tại các ngã ba, ngã tư hành lang, vị trí chuyển hướng đường thoát nạn.
   - Dọc theo hành lang dài: Khoảng cách giữa các đèn EXIT không được vượt quá $25\text{ m} - 30\text{ m}$.
2. **Quy cách & Cao độ lắp đặt**:
   - Sử dụng Block `EX` (Đèn EXIT 2 mặt hoặc 1 mặt) hoặc `chidanthoatnan1huong` (Đèn EXIT có mũi tên chỉ hướng 1 hướng / 2 hướng).
   - Cao độ lắp đặt:
     + Lắp trên dạ cửa: Cách mép trên khung cửa $100\text{ mm} - 200\text{ mm}$ (cao độ khoảng $+2.2\text{ m}$ đến $+2.5\text{ m}$).
     + Đèn chỉ dẫn tầm thấp: Lắp ở chân tường cách sàn $0.3\text{ m} - 0.5\text{ m}$ trong các hành lang rộng hoặc gara ngầm để người thoát nạn bò dưới khói vẫn nhìn thấy.
   - Nguồn dự phòng: Pin/ắc quy tích hợp sẵn duy trì chiếu sáng tối thiểu $\ge 2\text{ giờ}$ khi mất điện lưới.

---

## 2. YÊU CẦU ĐÈN CHIẾU SÁNG SỰ CỐ (EMERGENCY LIGHT - `EMERL`)

1. **Vị trí bố trí**:
   - Dọc theo các đường thoát nạn, hành lang, sảnh, buồng thang bộ, ram dốc.
   - Tại các phòng kỹ thuật điện, trạm bơm PCCC, phòng điều khiển trung tâm, phòng máy phát điện.
   - Khoảng cách giữa 2 đèn sự cố trên hành lang: Thông thường từ $10\text{ m} - 15\text{ m}$.
2. **Độ rọi yêu cầu (Illuminance)**:
   - Trên mặt sàn đường thoát nạn: Độ rọi tối thiểu $\ge 1.0\text{ lux}$ tại tim đường đi.
   - Tại vị trí đặt phương tiện PCCC (hộp vòi, bình chữa cháy, nút ấn báo cháy): Độ rọi tối thiểu $\ge 5.0\text{ lux}$.
3. **Quy cách Block CAD**:
   - Sử dụng Block `EMERL` (Đèn sự cố 2 bóng LED chiếu xoay hướng).
   - Cao độ lắp đặt: $Z = 2.2\text{ m} - 2.5\text{ m}$ trên tường hoặc treo trần.

---

## 3. THỂ HIỆN BẢN VẼ CAD CHUẨN BÁCH KHOA
- Ký hiệu Block: `EMERL` (Đèn sự cố), `EX` (Đèn EXIT), `chidanthoatnan1huong` (Đèn EXIT chỉ hướng).
- Layer đường dây: `Dây báo cháy` hoặc `DAYDIEN` (Dây chống cháy CU/FR 2x1.5mm2 luồn ống PVC D20).
- Ký hiệu bản vẽ: `CS-xx` (Mặt bằng đèn CSSC & EXIT — CS-01…CS-09 mặt bằng từng tầng, CS-10 sơ đồ nguyên lý cấp nguồn, CS-11 bảng tính toán nguồn điện), `EX-xx` / `EXR-xx` (Chỉ dẫn thoát nạn — EX-01…EX-09 tầng, EXR-01…EXR-07).
