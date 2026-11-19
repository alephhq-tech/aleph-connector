# Fire Alarm Standards Reference (TCVN 7568-14:2025)

This reference contains the normative engineering limits from TCVN 7568-14:2025 ("Hệ thống báo cháy -
Phần 14: Thiết kế, lắp đặt các hệ thống báo cháy cho nhà và công trình") and TCVN 3890:2023.

TCVN 7568-14:2025 replaces TCVN 7568-14:2015 **and TCVN 5738:2021** (Lời nói đầu). Do not quote
5738:2021 spacing figures for a new design; if the base drawing's own legend cites it, say the
drawing is on a cancelled standard.

## 1. Detector Selection Matrix (Bảng chọn loại đầu báo theo khu vực)

| Khu vực / Công năng                  | Loại đầu báo quy chuẩn                                          | Lý do kỹ thuật                                                                  |
| :----------------------------------- | :-------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| **Gara ô tô ngầm, bãi đỗ xe**        | **Đầu báo nhiệt gia tăng (Rate-of-Rise Heat)** hoặc Đa cảm biến | Tránh báo cháy giả do khói xả động cơ, bụi và độ ẩm; chống bám bẩn buồng quang. |
| **Bếp ăn, phòng đun nấu**            | **Đầu báo nhiệt cố định (Fixed Heat)**                          | Tránh báo giả do hơi nước, khói nấu nướng.                                      |
| **Phòng máy phát điện, nồi hơi**     | **Đầu báo nhiệt**                                               | Khí thải và nhiệt độ vận hành cao.                                              |
| **Hành lang, sảnh, văn phòng**       | **Đầu báo khói quang (Optical Smoke)**                          | Phát hiện sớm đám cháy âm ỉ từ vật liệu gỗ, giấy, vải.                          |
| **Phòng máy chủ, trung tâm dữ liệu** | **Đầu báo khói độ nhạy cao / VESDA**                            | Cảnh báo rất sớm bảo vệ thiết bị điện tử giá trị cao.                           |
| **Phòng biến áp, tủ điện tổng**      | **Đầu báo khói + nhiệt kết hợp**                                | Phát hiện quá nhiệt và khói cháy cách điện.                                     |

## 2. Point Smoke Detector Position Limits (Điều 5.9.1.1 - TCVN 7568-14:2025)

The 2025 edition states point-detector placement as **distances**, not as a protected-area quota per
detector. The controlling figure is the reach: every point of the protected ceiling must lie within it.

| Trần phẳng            | Mọi điểm trần → đầu báo gần nhất |        Giữa 2 đầu báo         | Hàng ngoài → tường/cửa cấp khí |
| :-------------------- | :------------------------------: | :---------------------------: | :----------------------------: |
| Khoảng cách tối đa    |   $7{,}2\text{ m}$ (5.9.1.1.2)   | $10{,}2\text{ m}$ (5.9.1.1.2) | $5{,}1\text{ m}$ (5.9.1.1.4 a) |
| Khoảng cách tối thiểu |                —                 |               —               | $0{,}5\text{ m}$ (5.9.1.1.4 a) |

- Đầu báo khói kiểu hút: bán kính bảo vệ 1 lỗ hút theo Bảng 2 (5.9.1.2.2) — đầu báo tia chiếu: khoảng
  cách giữa các tia $\le 14{,}4\text{ m}$ (Hình 6).
- Trần có dầm/ống sâu $>0{,}3\text{ m}$: mỗi ô bị chia coi như phòng riêng và phải được bảo vệ riêng
  (5.9.1.1.6).
- Khu vực thông gió cưỡng bức: giảm khoảng cách theo Bảng 1 (5.9.1.1.5) — ví dụ 15–<20 lần trao đổi
  khí/giờ → spacing $7{,}2\text{ m}$, tường $3{,}6\text{ m}$.

## 3. Point Heat Detector Position Limits (Điều 5.9.2.1 - TCVN 7568-14:2025)

| Trần phẳng            | Mọi điểm trần → đầu báo gần nhất |        Giữa 2 đầu báo        |       Hàng ngoài → tường       |
| :-------------------- | :------------------------------: | :--------------------------: | :----------------------------: |
| Khoảng cách tối đa    |   $5{,}1\text{ m}$ (5.9.2.1.2)   | $7{,}2\text{ m}$ (5.9.2.1.2) | $3{,}6\text{ m}$ (5.9.2.1.4 a) |
| Khoảng cách tối thiểu |                —                 |              —               | $0{,}3\text{ m}$ (5.9.2.1.4 a) |

- Bộ cảm biến phải cách trần $0{,}015\text{–}0{,}1\text{ m}$ (5.9.2.1.1); mái cản đối lưu: $\le 0{,}35\text{ m}$.
- Ngưỡng kích hoạt của đầu báo cố định/kep phải cao hơn nhiệt độ tối đa của môi trường tại vị trí lắp
  ít nhất $20\text{ °C}$ (4.1.5.6).
- Không dùng đầu báo nhiệt gia tăng/kep trong môi trường biến động nhiệt $>5\text{ °C/min}$ (4.1.5.5).

## 4. Manual Call Point (MCP) & Alarm Combination Units (Điều 7)

- **Vị trí bắt buộc**: Đặt tại lối thoát nạn, cạnh cửa buồng thang bộ thoát nạn, sảnh tầng, hành lang chính.
- **Cao độ lắp đặt**: $1.4\text{ m} \pm 0.2\text{ m}$ tính từ mặt sàn hoàn thiện đến tâm nút ấn.
- **Bán kính bảo vệ**:
  - Không quá $50\text{ m}$ giữa hai nút ấn bất kỳ trong công trình thông thường.
  - Không quá $30\text{ m}$ trong tầng hầm, bãi xe và khu vực nguy cơ cháy cao.
- **Cấm kỵ**: Tuyệt đối không gắn nút ấn khẩn trên vách hoặc khung cửa buồng thang máy.

## 5. Circuit Wiring Invariants (Nguyên tắc đấu nối mạch)

1. **Topology**: Daisy-chain (nối tiếp thiết bị), không tạo nhánh chữ T (T-Tap) trên mạch thường.
2. **End-of-Line (EOL)**: Đặt ở thiết bị cuối cùng của mạch Zone.
3. **Loop Resistance**: Điện trở thuần của dây dẫn mạch tín hiệu không vượt quá thông số cho phép của tủ trung tâm (thường $\le 50\text{ }\Omega$).
4. **Cáp và ống bảo vệ**: Cáp tín hiệu $2 \times 1.5\text{ mm}^2$ chống cháy/chống nhiễu luồn trong ống PVC chống cháy D20 hoặc ống thép luồn dây EMT, đi vuông góc bám sát hệ dầm trần.
