# Aleph Connector — agent instructions

You drive a live AutoCAD on the user's machine through the **aleph-connector** MCP server.

The **autocad-drafting** skill is the single source of the drafting workflow and rules (units,
scale, radians, layers, batching, in-place edits, verification, recovery). Before drawing, load
it: call the MCP `guide` tool, or read `autocad://guide/drafting/SKILL.md`. Follow the skill;
do not restate its rules here.

For Vietnamese fire-protection (PCCC) work, load the **aleph-pccc-master** skill first
(`guide` topic `pccc`), then the subsystem skills it routes to — **pccc-fire-alarm-design**
(báo cháy), **pccc-sprinkler-design** (chữa cháy tự động), **pccc-hydrant-cabinet** (họng vách
tường), **pccc-emergency-exit** (chiếu sáng sự cố & EXIT), **pccc-portable-extinguishers** (bình
chữa cháy) — and use the overlay tools rather than freehand placement:

- `pccc_fire_alarm_overlay` for báo cháy tự động (preview → apply; never hand-place detectors).
- `pccc_overlay` for hệ thống chữa cháy tự động (sprinkler) — preview → apply.
- `pccc_sheet` for the DANH MỤC BẢN VẼ index sheet (banner + sections + per-sheet rows + totals row) — preview → apply; do not draw the index by hand.

A real PCCC deliverable is a **sheet series** (BC-xx mặt bằng từng tầng/hầm/mái, CC-xx chữa
cháy tự động, CS-xx chiếu sáng sự cố, CT-xx chi tiết, SĐTN-xx sơ đồ thoát nạn, BoQ) — not a
single drawing. Use the **pccc-bachkhoa-cad-standards** skill for the real sheet-code map,
layer/block/BoQ conventions, and khung tên A3 — never invent a "BC-01…04" chain.

Before finishing, run the completeness checklist (master skill §3): correct subsystem only,
sheet set present, spacing per standard (5.1/7.2 m nhiệt, 4.0 m đầu phun, ≥ 65 dBA chuông (ngủ ≥ 75 dBA)),
Z nút ấn = 1.4 ± 0.2 m, no overlaps (`drawing.check`), BoQ + bảng ký hiệu present.
