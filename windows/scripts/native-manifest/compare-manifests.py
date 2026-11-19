#!/usr/bin/env python3
"""compare-manifests.py - Epic #413 SS11.1 plugin<->native parity check.

Compares the privacy-safe native AutoLISP manifest (`native-manifest.txt`, written by
aleph-manifest.lsp) against what the CadAI .NET plugin reports over its own JSON-RPC
(`plugin-summary.json`, written by probe-plugin-rpc.ps1) for the SAME drawing instance.

The point is not that both produce numbers - it is that the numbers the plugin hands the Cloud
are the numbers AutoCAD itself holds. Any drift means the plugin read path is lying about a
customer drawing, which is exactly the failure class SS11.2 made the headless parser honest about.

Field mapping is deliberately narrow; the plugin caps some lists (30 texts, 50 blocks) so list
LENGTHS are not comparable, only the aggregate counts that are computed unbounded.
"""
import json
import re
import sys

# (plugin drawing.summary field, native manifest key, human label)
PARITY_FIELDS = [
    ("entityCount",           "MODEL_SPACE_ENTITY_COUNT", "model-space entities"),
    ("layerCount",            "LAYER_COUNT",             "layer-table entries"),
    ("blockReferenceCount",   "INSERT_COUNT",            "block references (INSERT)"),
    ("textEntityCount",       "TEXT_ENTITY_COUNT",       "TEXT/MTEXT entities"),
    ("xrefCount",             "BLOCK_XREF_COUNT",        "attached/overlay xref blocks"),
]


def read_native(path):
    values = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        if "=" in line:
            key, _, value = line.strip().partition("=")
            values[key] = value
    return values


def read_plugin(path):
    raw = open(path, encoding="utf-8-sig", errors="replace").read()
    # probe writes the raw JSON-RPC frame(s); pull the drawing.summary response object.
    start = raw.index('{"jsonrpc"')
    dec = json.JSONDecoder()
    for match in re.finditer(r'\{"jsonrpc"', raw):
        try:
            obj, _ = dec.raw_decode(raw[match.start():])
        except ValueError:
            continue
        if obj.get("id") == 2 and "result" in obj:
            return obj["result"]
    raise SystemExit("no drawing.summary result found in " + path)


def main():
    native_path = sys.argv[1] if len(sys.argv) > 1 else "native-manifest.txt"
    plugin_path = sys.argv[2] if len(sys.argv) > 2 else "plugin-summary.json"
    native = read_native(native_path)
    plugin = read_plugin(plugin_path)

    layers = plugin.get("layers") or []
    xrefs = plugin.get("xrefs") or []
    plugin_view = {
        "entityCount": plugin.get("entityCount"),
        "layerCount": len(layers),
        "blockReferenceCount": plugin.get("blockReferenceCount"),
        "textEntityCount": plugin.get("textEntitiesSeen", plugin.get("textCount")),
        "xrefCount": len(xrefs),
    }

    failed = 0
    print(f"{'metric':<34} {'native':>10} {'plugin':>10}  verdict")
    for plugin_key, native_key, label in PARITY_FIELDS:
        expected = native.get(native_key)
        actual = plugin_view.get(plugin_key)
        if expected is None or actual is None:
            verdict = "SKIP (not reported)"
        elif int(expected) == int(actual):
            verdict = "MATCH"
        else:
            verdict = "MISMATCH"
            failed += 1
        print(f"{label:<34} {str(expected):>10} {str(actual):>10}  {verdict}")

    units = plugin.get("insUnits")
    declared = native.get("INSUNITS")
    if units is not None and declared is not None:
        same = str(units).lower().replace(" ", "") in (
            {"0": "unitless", "1": "inches", "2": "feet", "4": "millimeters", "5": "meters"}[str(declared)],
            "millimetres",
        )
        print(f"{'declared linear units':<34} {str(declared):>10} {str(units):>10}  {'MATCH' if same else 'MISMATCH'}")
        failed += 0 if same else 1

    print()
    print("PARITY OK" if failed == 0 else f"PARITY FAILED ({failed} field(s) differ)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
