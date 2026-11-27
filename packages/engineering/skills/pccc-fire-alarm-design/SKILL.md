---
name: pccc-fire-alarm-design
description: Design code-compliant automatic fire alarm systems per TCVN 7568-14:2025 (which superseded TCVN 5738:2021), TCVN 3890:2023, and QCVN 06:2022/BXD. Select appropriate detector types based on space occupancy (Rate-of-Rise Heat for basement parking/kitchens vs. Optical Smoke for offices/corridors/lobbies), position detectors within clause reach, enforce manual call point placement at egress stairs, avoid elevator shafts and ramps, and plan strictly non-branching Daisy-Chain circuits with End-of-Line resistors.
---

# THIẾT KẾ HỆ THỐNG BÁO CHÁY TỰ ĐỘNG (TCVN 7568-14:2025)

Hệ thống Báo cháy tự động là hạng mục cốt lõi trong hồ sơ thiết kế PCCC, chịu sự điều chỉnh trực tiếp của tiêu chuẩn quốc gia **TCVN 7568-14:2025** ("Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt các hệ thống báo cháy cho nhà và công trình").

> [!IMPORTANT]
> **TCVN 5738:2021 ĐÃ BỊ HỦY BỎ VÀ THAY THẾ HOÀN TOÀN.**
> Lời nói đầu của TCVN 7568-14:2025 quy định tiêu chuẩn này thay thế TCVN 5738:2021 và TCVN 7568-14:2015. Trong mọi hồ sơ và bảng ghi chú kỹ thuật, bắt buộc viện dẫn TCVN 7568-14:2025.

---

## 1. NGUYÊN TẮC LỰA CHỌN ĐẦU BÁO THEO CÔNG NĂNG PHÒNG

| Khu vực công năng | Loại đầu báo bắt buộc | Bán kính bảo vệ ($R$) | Khoảng cách giữa 2 đầu báo | Cách tường | Lý do kỹ thuật chuyên ngành |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Gara ô tô ngầm, bãi giữ xe máy** | **Đầu báo nhiệt gia tăng (Rate-of-Rise Heat)** | $\le 5.1\text{ m}$ | $\le 7.2\text{ m}$ | $0.3 - 3.6\text{ m}$ | **Khí thải động cơ xe cộ gây báo cháy giả liên tục nếu dùng đầu báo khói quang. CẤM dùng đầu báo khói trong gara ngầm.** |
| **Phòng máy phát điện, trạm biến áp** | **Đầu báo nhiệt gia tăng** | $\le 5.1\text{ m}$ | $\le 7.2\text{ m}$ | $0.3 - 3.6\text{ m}$ | Có dầu bôi trơn, nhiệt độ thay đổi nhanh khi máy chạy. |
| **Bếp ăn, khu đun nấu** | **Đầu báo nhiệt gia tăng** | $\le 5.1\text{ m}$ | $\le 7.2\text{ m}$ | $0.3 - 3.6\text{ m}$ | Hơi nước và khói nấu ăn gây nhiễu cảm biến quang. |
| **Sảnh đón, sảnh thang máy** | **Đầu báo khói quang (Optical Smoke)** | $\le 7.2\text{ m}$ | $\le 10.2\text{ m}$ | $0.5 - 5.1\text{ m}$ | Phát hiện khói âm ỉ giai đoạn đầu đám cháy. |
| **Hành lang, lối thoát hiểm** | **Đầu báo khói quang** | $\le 7.2\text{ m}$ | $\le 10.2\text{ m}$ | $0.5 - 5.1\text{ m}$ | Bảo vệ trục đường thoát nạn chính. |
| **Phòng văn phòng, làm việc** | **Đầu báo khói quang** | $\le 7.2\text{ m}$ | $\le 10.2\text{ m}$ | $0.5 - 5.1\text{ m}$ | Tải trọng cháy chủ yếu là giấy tờ, gỗ, thiết bị điện tử. |
| **Kho vật tư thông thường** | **Đầu báo khói quang** | $\le 7.2\text{ m}$ | $\le 10.2\text{ m}$ | $0.5 - 5.1\text{ m}$ | Phát hiện sớm trước khi bùng phát ngọn lửa lớn. |

---

## 2. NGUYÊN TẮC BỐ TRÍ NÚT ẤN KHẨN & CHUÔNG CÒI

1. **Vị trí nút ấn khẩn cấp (`NUT NHAN KHAN CAP`)**:
   - Bố trí tại **cửa vào buồng thang bộ thoát hiểm** hoặc lối ra thoát nạn chính của mỗi tầng.
   - Vị trí lắp đặt: Phía ngoài sảnh đón hành lang, bên cạnh khung cửa thoát hiểm.
   - Cao độ lắp đặt: $Z = 1.4\text{ m} \pm 0.2\text{ m}$ so với mặt sàn hoàn thiện.
   - **CẤM**: Gắn nút ấn trên vách buồng cabin thang máy hoặc trong góc khuất.
2. **Vị trí chuông còi kết hợp đèn chớp (`CHUONG BAO CHAY`)**:
   - Lắp đặt đồng trục ngay phía trên nút ấn báo cháy khẩn cấp hoặc trên dạ cửa buồng thang.
   - Cao độ lắp đặt: $Z = 2.2\text{ m} - 2.5\text{ m}$ so với sàn (cách trần $\ge 0.15\text{ m}$).
   - Mức cường độ âm thanh: ≥ 65 dBA (khu vực ngủ ≥ 75 dBA), không lớn hơn 105 dBA; mức âm vượt độ ồn môi trường ≥ 10 dBA (≥ 15 dBA khu vực ngủ) — tính trung bình 60 s (5.11.2.1, TCVN 7568-14:2025).

### Cấu kiện dầm sâu > 0.3 m
- **Heat detectors** (5.9.2.1.5): dầm sâu $>0.3\text{ m}$ — spacing giảm **30%** (7.2 m → 5.0 m; reach 5.1 m → 3.6 m).
- **Smoke detectors** (5.9.1.1.6): dầm $\ge 0.3\text{ m}$ — ô giữa dầm $< 4\text{ m}^2$ (trần 2–4 m) → lắp dưới mặt dầm; ô $\ge 4\text{ m}^2$ → ≥ 1 đầu báo mỗi ô; trần $\ge 4\text{ m}$ + ô $< 9\text{ m}^2$ → dưới mặt dầm; ô $\ge 9\text{ m}^2$ → trong ô.
- Dầm sâu $>0.3\text{ m}$: mỗi ô giữa các dầm được coi là **phòng riêng**, phải bảo vệ riêng.
- Đầu báo khói cách cửa cấp khí / quạt ≥ 0.4 m (5.9.1.1.4 b, c); đầu báo nhiệt cách cửa cấp khí ≥ 0.6 m (5.9.2.1.4 b); cách trần $0.025\text{–}0.3\text{ m}$ (trần <4 m), $\le 0.6\text{ m}$ (trần 4–15 m).

---

## 3. NGUYÊN TẮC ĐỊNH TUYẾN DÂY TÍN HIỆU (DAISY-CHAIN LOOP)

Kỹ sư thiết kế tuyệt đối tuân thủ cấu trúc mạch điện sau:
1. **Mạch Daisy-Chain không rẽ nhánh (Strict Non-Branching)**:
   - Tuyến dây tín hiệu loop bắt đầu từ Tủ trung tâm báo cháy (FACP) hoặc Hộp nối dây kỹ thuật (`BOX NOI DAY FA`) tại trục đứng.
   - Dây đi qua Nút ấn khẩn -> Đầu báo 1 -> Đầu báo 2 -> ... -> Đầu báo N.
   - Tại đầu báo cuối cùng trên mạch quy ước, lắp đặt **Điện trở cuối tuyến (EOL Resistor $4.7\text{ k}\Omega$)** để giám sát đứt dây.
   - CẤM rẽ nhánh chữ T (No T-Tap) trên đường tín hiệu.
2. **Định tuyến trực giao bám dầm kết cấu (Orthogonal Highway Routing)**:
   - Tuyến dây chỉ chạy thẳng góc 0° hoặc 90°, bám sát theo mép dầm trần kết cấu bê tông.
   - **CẤM ĐÂM XUYÊN BUỒNG THANG MÁY**: Tuyến dây phải vòng ra ngoài sảnh đón, né hoàn toàn 4 vách và không gian giếng thang máy.
   - **NÉ RAM DỐC XE**: Không hạ dây thấp qua khoảng tĩnh không ram dốc xe lên xuống.
3. **Quy cách dây dẫn & Ống bảo vệ**:
   - Dây tín hiệu loop: Cáp chống cháy `2x1.0mm2` (layer `2x1.0mm`), luồn trong ống nhựa chống cháy PVC D20 đi nổi sát trần.
   - Dây nguồn cấp chuông còi/module: Cáp chống cháy `2x1.5mm2` (layer `2x1.5mm`).

---

## 4. QUY TRÌNH THỰC HIỆN TRÊN LIVE AUTOCAD VỚI ALEPH CONNECTOR

Để đảm bảo độ chính xác tuyệt đối, không đâm xuyên thang máy và tự động loại bỏ rủi ro đè chữ:
1. **Kiểm tra mặt bằng**: Gọi `drawing.inspect_floorplan` với tên mặt bằng (vd: `"MẶT BẰNG TẦNG HẦM"`).
2. **Thiết kế & Bố trí 1-Shot**: Sử dụng `pccc_fire_alarm_overlay` (thao tác `preview` rồi `apply`):
   - Phân loại phòng: Gara ngầm -> gán đầu báo nhiệt; phòng văn phòng/sảnh -> gán đầu báo khói.
   - Loại trừ hoàn toàn hố thang máy và ram dốc.
3. **Kiểm tra chất lượng (Verification)**:
   - Gọi `drawing.check` với scope kiểm tra chồng chéo text và đường nét.
   - Bảng ký hiệu & Thống kê vật tư xuất sang góc phải bản vẽ theo đúng form chuẩn Bách Khoa.
