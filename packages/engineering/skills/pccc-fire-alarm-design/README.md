# Aleph PCCC - Hệ thống Thiết kế Bản vẽ PCCC Chuẩn Việt Nam

Plugin chuyên sâu dành cho Antigravity và `aleph-connector`, trang bị cho toàn bộ AI Agent kiến thức chuyên môn, quy chuẩn kỹ thuật và kỹ năng vẽ bản vẽ AutoCAD tương đương một kỹ sư thiết kế PCCC giàu kinh nghiệm tại **Công ty TNHH Cơ Điện Lạnh & PCCC Bách Khoa**.

---

## 1. Căn cứ Pháp lý & Tiêu chuẩn Thiết kế Hiện hành
1. **TCVN 5040:1990** (ISO 6790:1986): Thiết bị phòng cháy và chữa cháy - Ký hiệu hình vẽ dùng trên sơ đồ phòng cháy.
2. **TCVN 7568-14:2025**: Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt cho nhà và công trình (*Thay thế hoàn toàn TCVN 5738:2021 và TCVN 7568-14:2015*).
3. **TCVN 7336:2021**: Phòng cháy chữa cháy - Hệ thống chữa cháy tự động bằng nước, bọt (Sprinkler & Drencher).
4. **TCVN 13456:2022**: Phòng cháy chữa cháy - Phương tiện chiếu sáng sự cố và chỉ dẫn thoát nạn.
5. **TCVN 3890:2023**: Phòng cháy chữa cháy - Phương tiện phòng cháy và chữa cháy cho nhà và công trình - Trang bị, bố trí.
6. **QCVN 06:2022/BXD & Sửa đổi 1:2023**: Quy chuẩn kỹ thuật quốc gia về An toàn cháy cho nhà và công trình.
7. **QCVN 02:2020/BCA**: Quy chuẩn kỹ thuật quốc gia về Trạm bơm nước chữa cháy.

---

## 2. Các Hạng mục Thiết kế (Disciplines)
- **Hạng mục 1: Báo cháy tự động (BC)**: Địa chỉ (Addressable) hoặc Quy ước (Conventional). Tự động phân loại đầu báo nhiệt cho gara ngầm/bếp/máy phát; đầu báo khói quang cho sảnh/văn phòng/hành lang.
- **Hạng mục 2: Chữa cháy Sprinkler tự động (CC)**: Bố trí đầu phun `dp`, mạng đường ống phân cấp `DN 25` đến `DN 150`, cụm Alarm Valve, Flow Switch, van kèm công tắc giám sát OS&Y.
- **Hạng mục 3: Họng nước chữa cháy vách tường (CC)**: Hộp tủ chữa cháy `họng 1 cửa` kèm cuộn vòi D50/D65, van góc, lăng phun và họng tiếp nước PCCC ngoài nhà.
- **Hạng mục 4: Chiếu sáng sự cố & Đèn EXIT (CSSC)**: Đèn sự cố `EMERL` và đèn EXIT `EX` tại các vị trí cửa thoát hiểm, ngã rẽ hành lang, buồng thang bộ.
- **Hạng mục 5: Bình chữa cháy ban đầu (ABC / CO2)**: Bình bột `ABC` (MFZ4/MFZL4) và khí `MT3`/`MT5` bố trí trong tủ hoặc treo tường.
- **Hạng mục 6: Hút khói & Thông gió tăng áp**: Quạt hút khói hành lang/gara, quạt tăng áp buồng thang bộ, van chặn lửa liên động báo cháy.

---

## 3. Tiêu chuẩn Thể hiện CAD Chuẩn Bách Khoa
- **Tuyệt đối không đè chữ (Zero Text Collision)**: Khoảng hở an toàn với đường kích thước, cao độ và ký hiệu thiết bị.
- **Tuyến dây/ống trực giao bám dầm**: Tuyến dây Daisy-Chain nối tiếp, né giếng thang máy và ram dốc.
- **Bảng ký hiệu & Thống kê vật tư (BoQ)**: Khung bảng chuẩn kỹ thuật, chiều cao hàng và cột tính toán theo tỷ lệ bản vẽ.
- **Ký hiệu bản vẽ chuẩn**: `BC-xx` mặt bằng từng tầng/hầm/mái (BC-01…BC-09 + BC-10…17 trần thô + BC-18 sơ đồ), `CS-xx` chiếu sáng sự cố (CS-01…CS-11), `CC-xx` chữa cháy tự động (CC-01…09) + vách tường (CC-10…21), `EX-xx` / `EXR-xx` chỉ dẫn thoát nạn (EX-01…09 + EXR-01…07), `CT-xx` chi tiết (CT-01…06), cộng Bìa + Bìa ký + Thống kê vật tư + Danh mục bản vẽ. Không dùng chuỗi cố định BC-01…04 cho các dự án nhiều tầng.
