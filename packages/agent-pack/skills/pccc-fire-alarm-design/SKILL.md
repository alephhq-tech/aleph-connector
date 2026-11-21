---
name: pccc-fire-alarm-design
description: Design code-compliant automatic fire alarm systems per TCVN 7568-14:2025 (which superseded TCVN 5738:2021), TCVN 3890:2023, and QCVN 06:2022/BXD. Select appropriate detector types based on space occupancy (heat for parking/kitchens vs. smoke for offices/corridors), position detectors so every point of the protected ceiling is within the clause reach, enforce manual call point placement at egress stairs, avoid air turbulence dead-zones, and plan strictly non-branching Daisy-Chain circuits with End-of-Line resistors.
---

# PCCC Automatic Fire Alarm Design (Hệ thống Báo cháy tự động)

Assist a qualified fire-protection engineer; never imply that AI-generated plans are professionally certified. Every automatic fire alarm layout must adhere to TCVN 7568-14:2025 ("Hệ thống báo cháy - Phần 14: Thiết kế, lắp đặt các hệ thống báo cháy cho nhà và công trình"), TCVN 3890:2023, và QCVN 06:2022/BXD (Sửa đổi 1:2023).

**TCVN 5738:2021 đã bị hủy bỏ.** Lời nói đầu của TCVN 7568-14:2025 ghi rõ tiêu chuẩn này thay thế cả
TCVN 7568-14:2015 lẫn TCVN 5738:2021. Một bản vẽ còn ghi "TCVN 5738:2021" trong bảng kê thì đó là
bằng chứng bản vẽ cũ, không phải căn cứ thiết kế hiện hành; nói rõ cho người dùng thay vì âm thầm
dùng số của nó.

## Core Engineering Invariants (Các nguyên tắc cốt lõi)

1. **Phân loại và khoảng cách cảm biến** (trần phẳng, điều 5.9):

   | Loại                                                  | Mọi điểm trần → đầu báo gần nhất | Giữa 2 đầu báo        | Hàng ngoài → tường                        |
   | ----------------------------------------------------- | -------------------------------- | --------------------- | ----------------------------------------- |
   | Nhiệt (gara, bếp, máy phát)                           | $\le 5{,}1\text{ m}$ (5.9.2.1.2) | $\le 7{,}2\text{ m}$  | $0{,}3\text{–}3{,}6\text{ m}$ (5.9.2.1.4) |
   | Khói quang kiểu điểm (văn phòng, hành lang, kỹ thuật) | $\le 7{,}2\text{ m}$ (5.9.1.1.2) | $\le 10{,}2\text{ m}$ | $0{,}5\text{–}5{,}1\text{ m}$ (5.9.1.1.4) |
   - Giới hạn phủ là **khoảng cách tới điểm trần gần nhất**, không phải "diện tích bảo vệ bao nhiêu m²
     cho mỗi đầu báo". Bản 2025 không còn định mức m²/đầu báo cho đầu báo kiểu điểm; lưới ô vuông bước
     $S$ để hở điểm xa nhất $S/\sqrt2$, nên bước lưới phải lấy từ cột "mọi điểm trần", không lấy từ cột
     "giữa 2 đầu báo".
   - Gara ô tô, xe máy ngầm: **BẮT BUỘC dùng Đầu báo nhiệt gia tăng (Rate-of-Rise Heat)**. CẤM dùng đầu báo khói quang (S) trong gara.

2. **Nút ấn khẩn (MCP) & Chuông còi**:
   - Bố trí tại cửa buồng thang bộ thoát hiểm hoặc lối thoát nạn chính, cao độ $Z = 1.4\text{ m}$. CẤM gắn trên vách buồng thang máy.
3. **Mạch tín hiệu & Định tuyến dây**:
   - Dây đi theo dạng **Daisy-Chain nối tiếp**, CẤM rẽ nhánh chữ T (No T-Tap).
   - Đi dây **vuông góc bám theo dầm trần / trục cột**, CẤM đi đường chéo.
   - **CẤM ĐÂM XUYÊN BUỒNG THANG MÁY**: Tuyến dây phải chạy bên ngoài hành lang hoặc bám trục dầm an toàn, né hoàn toàn khu vực cabin và vách giếng thang máy.
   - Lắp điện trở cuối tuyến (EOLR) $4.7\text{ k}\Omega$ tại đầu báo cuối cùng.

## Fast 1-Shot Automated Workflow (BẮT BUỘC SỬ DỤNG)

Để đảm bảo bản vẽ chính xác, không đâm xuyên thang máy và không phải đoán mò tọa độ, **BẮT BUỘC dùng công cụ 1-shot `pccc_fire_alarm_overlay`** thay vì tự vẽ thủ công từng nét bằng `operations`.

### Quy trình 2 bước

1. **Preview (`operation: "preview"`)** — truyền:
   - `floorplanName`: đúng tên mặt bằng ghi trên bản vẽ (vd `"MẶT BẰNG TẦNG HẦM"`). Tool tự đọc vùng thật của mặt bằng đó từ CAD (`drawing.inspect_floorplan`) và **từ chối toàn bộ preview** nếu polygon phòng nào rơi ngoài vùng: `ROOM_OUTSIDE_FLOORPLAN` (phòng đặt sai chỗ / gõ tọa độ tùy ý) hoặc `FLOORPLAN_REGION_UNRESOLVED` (tên không khớp vùng nào đã kiểm chứng). Đây là chốt chặn khiến overlay không thể vẽ lệch ra ngoài khung mặt bằng.
   - `rooms`: **cách đúng là truyền `ref` + `usage`, không truyền polygon.** `drawing.inspect_floorplan` trả mỗi phòng đã đọc kèm một `ref` (định danh theo revision) và đường bao kín do chính bản vẽ cung cấp; preview lấy lại đường bao đó theo `ref`. Phòng `usage: "elevator"` tự động bị loại khỏi lưới đầu báo và thành vùng cấm đi dây — cũng không cần nhập lại polygon. `boundary` / `elevatorShafts` **bắt buộc** kèm `acceptCallerGeometry: true` (drafting-only) và phải lấy từ `entity.traceBoundary`, không gõ tay. Không có accept → `CALLER_GEOMETRY_REQUIRES_ACCEPT`. Một phòng không resolve được hình bao sẽ bị chặn bằng `ROOM_REF_UNRESOLVED` — **không** bịa box.
   - `candidateIndex`: khi sheet có nhiều bản sao cùng mặt bằng, truyền đúng index đã dùng lúc inspect (cùng field với `drawing.inspect_floorplan`).
   - Kết quả preview liệt kê `rooms[].boundarySource` (`cad` | `caller`). Báo rõ cho user.
   - `symbolLibraryPath`: **tùy chọn**. Khi bỏ trống, Aleph dùng default symbol geometry / catalog workspace — **không** bịa đường Windows kiểu `C:\Users\...\ki hieu.dwg`. Chỉ truyền path thật khi cần thư viện nhà.
   - `elevatorPickPoints`: khi kiến trúc là block gộp, một điểm trong mỗi hố thang → CAD `traceBoundary`.
   - `stairDoors`, `beamYHighways` (nếu có; thiếu thì tool cố derive từ CAD evidence).

2. **Apply (`operation: "apply"`, `planId`)** — chỉ vẽ khi plan không bị block. apply import các block thiếu (nếu có) rồi vẽ, tất cả entity trong một batch có undo; bản import **không** nằm trong undo group đó (nó chỉ đưa định nghĩa block vào, instance dò bị xóa ngay — journal nó thì `revert` sẽ báo `RevertConflict`). Định nghĩa block còn lại trong bản vẽ: inert, không hiển thị, `PURGE` được.

### Một bước: `operation: "execute"`

Với yêu cầu thường lệ (không cần người duyệt giữa hai bước), dùng `execute`: **một** lời gọi chạy đúng đường compile + mọi chốt chặn của `preview`, rồi chỉ vẽ khi plan **không** bị block. Nếu có chốt nào chặn, nó trả `violations` y hệt `preview` và `drawn: false` — **không** vẽ gì cả. Đây là cùng một code path, không phải đường yếu hơn. Kết quả mang cả báo cáo compile (`rooms[].boundarySource`, số thiết bị, `importAtApply`) trên biên bản vẽ. Giữ `preview` + `apply` tách đôi khi người dùng muốn xem plan trước khi đồng ý vẽ.

### Plan bị block nghĩa là gì

`preview` trả `status: "FAIL"` kèm `violations`. Phải sửa input rồi preview lại — **không** vẽ đè, **không** thay bằng kí hiệu tự vẽ:

| Violation                     | Nguyên nhân                                                                                                                                                                | Cách xử lý                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CALLER_GEOMETRY_REQUIRES_ACCEPT` | truyền `rooms[].boundary` / `elevatorShafts` mà không có `acceptCallerGeometry: true`                                                                               | dùng `ref` từ inspect, hoặc thêm accept + ring từ `entity.traceBoundary`                                                                                                                                                         |
| `MISSING_SYMBOL:<loai>`       | thiếu symbol sau khi đã thử default/catalog/library                                                                                                                        | truyền `symbolLibraryPath` thật nếu có thư viện nhà, hoặc bảo user nạp block — không bịa path                                                                                                                                   |
| `ELEVATOR_UNTRACED`           | điểm pick không tạo ra đường bao kín                                                                                                                                       | chọn điểm khác sâu hơn trong hố thang, hoặc truyền thẳng `elevatorShafts`                                                                                                                                                        |
| `ELEVATOR_AREA_SUSPECT`       | diện tích dò được không hợp lý cho hố thang                                                                                                                                | kiểm tra điểm pick rơi vào sảnh thay vì giếng thang                                                                                                                                                                              |
| `ROOM_OUTSIDE_FLOORPLAN`      | polygon phòng nằm ngoài vùng mặt bằng đã kiểm chứng                                                                                                                        | lấy boundary từ CAD (`drawing.inspect_floorplan` rooms / `entity.traceBoundary`), không gõ tọa độ                                                                                                                                |
| `FLOORPLAN_REGION_UNRESOLVED` | `floorplanName` không khớp vùng nào có bằng chứng                                                                                                                          | dùng đúng tên mặt bằng bản vẽ liệt kê (`availableFloorplans`), hoặc truyền `candidateIndex` khi có nhiều bản sao                                                                                                                 |
| `UNCOVERED_CEILING`           | có điểm trần được bảo vệ mà không vị trí hợp lệ nào với tới được trong giới hạn điều 5.9                                                                                   | kiểm tra lại polygon phòng/vùng cấm: phòng quá hẹp quanh giếng thang không thể phủ; đừng thêm đầu báo thủ công                                                                                                                   |
| `DRAWN_OUTSIDE_FLOORPLAN`     | bản thân các entity sẽ vẽ (nút ấn theo `stairDoors[].doorPoint`, điện trở cuối tuyến/offset nhãn, dây theo `beamYHighways`) rơi ngoài khung, dù mọi polygon phòng đều đúng | soát lại `stairDoors[].doorPoint`, `beamYHighways`, `symbolScale` so với khung mà tool đã báo                                                                                                                                    |
| `NO_STRUCTURAL_HIGHWAY`       | không trục dầm nào trong `beamYHighways` nối được hai thiết bị mà không cắt vùng cấm                                                                                       | đọc trục kết cấu thật từ bản vẽ (lưới trục/trục ghi trong khung) rồi truyền vào `beamYHighways`, hoặc chia nhỏ mạch. Tool **không** tự bịa trục: dây chỉ đi trên dầm có thật, và span không nối được thì không vẽ gì cho span đó |
| `ELEVATOR_SHAFT_DOOR`         | `stairDoors[].doorPoint` nằm **trong** hoặc sát (< 0,5 m) giếng thang máy                                                                                                  | lấy điểm cửa nằm phía sảnh của buồng thang; nút ấn không được gắn trên vách/ trong giếng thang máy                                                                                                                               |

### Cấm

- Cấm dùng `operations`/`entity.create` để vẽ đầu báo bằng circle + chữ thay cho block. Kí hiệu phải là block reference từ thư viện chuẩn; không có block thì báo thiếu, không vẽ giả.
- Cấm tự vẽ hình chữ nhật bao phòng/thang máy để "làm cho phân tích không gian chạy được".
