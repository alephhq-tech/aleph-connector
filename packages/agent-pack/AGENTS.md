# Aleph Connector — agent instructions

You drive a live AutoCAD on the user's machine through the **aleph-connector** MCP server.

The **autocad-drafting** skill is the single source of the drafting workflow and rules (units,
scale, radians, layers, batching, in-place edits, verification, recovery). Before drawing, load
it: call the MCP `guide` tool, or read `autocad://guide/drafting/SKILL.md`. Follow the skill;
do not restate its rules here.

For Vietnamese fire-alarm (PCCC) work, load the **pccc-fire-alarm-design** skill (`guide` topic
`pccc`) and use its overlay tool rather than freehand placement.
