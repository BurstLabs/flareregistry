#!/usr/bin/env python3
# Render the Flare Foundation markdown document to a styled, readable PDF via headless Chrome.
#   python3 scripts/build-ff-pdf.py
import re, html, subprocess, os, base64

SRC = "docs/flare-registry-vs-legacy-for-flare-foundation.md"
OUT = "docs/flare-registry-vs-legacy-for-flare-foundation.pdf"
LOGO = "public/logo.png"  # embedded as a branded header at the top of the document

md = open(SRC).read()


def inline(t):
    t = html.escape(t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t, flags=re.S)
    t = re.sub(r"`(.+?)`", r"<code>\1</code>", t)
    t = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', t)
    return t


def blocks(md):
    out, cur = [], []
    for line in md.split("\n"):
        if line.strip() == "":
            if cur:
                out.append("\n".join(cur))
                cur = []
            out.append("")
        else:
            cur.append(line)
    if cur:
        out.append("\n".join(cur))
    return out


parts = []
for b in blocks(md):
    if b == "":
        continue
    bl = b.split("\n")
    first = bl[0]
    if "|" in first and len(bl) > 1 and re.match(r"^\s*\|?[\s:|-]+\|?\s*$", bl[1]):
        header = [c.strip() for c in bl[0].strip().strip("|").split("|")]
        t = "<table><thead><tr>" + "".join(f"<th>{html.escape(c)}</th>" for c in header) + "</tr></thead><tbody>"
        for row in bl[2:]:
            if "|" not in row:
                continue
            cells = [c.strip() for c in row.strip().strip("|").split("|")]
            t += "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells) + "</tr>"
        parts.append(t + "</tbody></table>")
        continue
    if first.startswith("### "):
        parts.append(f"<h3>{inline(first[4:])}</h3>"); continue
    if first.startswith("## "):
        parts.append(f"<h2>{inline(first[3:])}</h2>"); continue
    if first.startswith("# "):
        parts.append(f"<h1>{inline(first[2:])}</h1>"); continue
    if first.strip() == "---":
        parts.append("<hr>"); continue
    if re.match(r"^\s*[-*] ", first) or re.match(r"^\s*\d+\. ", first):
        ordered = bool(re.match(r"^\s*\d+\. ", first))
        items, buf = [], None
        for ln in bl:
            if re.match(r"^\s*[-*] ", ln) or re.match(r"^\s*\d+\. ", ln):
                if buf is not None:
                    items.append(buf)
                buf = re.sub(r"^\s*([-*]|\d+\.) ", "", ln)
            else:
                buf = (buf or "") + " " + ln.strip()
        if buf is not None:
            items.append(buf)
        tag = "ol" if ordered else "ul"
        parts.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>")
        continue
    flat = " ".join(x.strip() for x in bl)
    if flat.startswith("*") and flat.endswith("*") and flat.count("**") == 0:
        parts.append(f'<p class="note">{inline(flat)}</p>'); continue
    parts.append(f"<p>{inline(flat)}</p>")

body = "\n".join(parts)

callout = """<div class="callout"><div class="callout-title">The problem, in numbers</div>
<div class="stats">
<div class="stat"><div class="num">114</div><div class="lbl">days the oldest provider request has waited</div></div>
<div class="stat"><div class="num">117</div><div class="lbl">days issue #434 (a &ldquo;listed&rdquo; request) has sat open</div></div>
<div class="stat"><div class="num">22</div><div class="lbl">avg. days to merge (slowest: 135)</div></div>
<div class="stat"><div class="num">9</div><div class="lbl">requests open over 30 days</div></div>
</div></div>"""
body = body.replace("<h2>1. The problem, with evidence</h2>", callout + "\n<h2>1. The problem, with evidence</h2>", 1)

css = """
@page { margin: 20mm 18mm; }
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#222;line-height:1.45;font-size:13.5px}
h1{font-size:26px;color:#1a1a1a;margin:0 0 4px;font-weight:700;letter-spacing:-.3px;line-height:1.2}
h2{font-size:17.5px;margin:26px 0 9px;color:#1a1a1a;font-weight:700;border-left:4px solid #f5a623;padding-left:10px;line-height:1.25}
h3{font-size:14px;margin:18px 0 5px;color:#444;font-weight:700;line-height:1.3}
p{margin:9px 0;line-height:1.45}
.note{color:#888;font-size:12px;font-style:italic;border-top:1px solid #eee;padding-top:10px;line-height:1.5}
table{border-collapse:collapse;width:100%;margin:13px 0;font-size:12px}
th,td{border:1px solid #e3e3e3;padding:7px 10px;text-align:left;vertical-align:top;line-height:1.35}
th{background:#faf3e6;font-weight:700;color:#7a4d08}
tr:nth-child(even) td{background:#fafafa}
code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:11.5px;color:#9a3b3b}
hr{border:none;border-top:1px solid #eee;margin:22px 0}
a{color:#b8740f;text-decoration:none;border-bottom:1px solid #e9cfa0}
ul,ol{margin:8px 0;padding-left:22px}
li{margin:5px 0;line-height:1.45}
strong{color:#111}
.callout{background:#fcf7ee;border:1px solid #f0dcb8;border-radius:10px;padding:16px 18px;margin:16px 0 6px;break-inside:avoid}
.callout-title{font-size:12px;font-weight:700;color:#7a4d08;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.stats{display:flex;gap:14px}
.stat{flex:1;text-align:center}
.num{font-size:28px;font-weight:800;color:#e07b1a;line-height:1}
.lbl{font-size:10px;color:#666;margin-top:5px;line-height:1.3}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.brand img{width:34px;height:34px}
.brand .name{font-size:18px;font-weight:700;color:#1a1a1a}
.brand .name b{color:#e07b1a}
"""

# Branded header: a text wordmark above the title.
brand = '<div class="brand"><span class="name"><b>Flare</b> Registry</span></div>'

open("/tmp/ff.html", "w").write(f'<html><head><meta charset="utf-8"><style>{css}</style></head><body>{brand}{body}</body></html>')
assert open("/tmp/ff.html").read().count("**") == 0, "stray ** in output"
subprocess.run(
    ["google-chrome", "--headless", "--disable-gpu", "--no-sandbox",
     "--print-to-pdf=" + os.path.abspath(OUT), "--no-pdf-header-footer", "/tmp/ff.html"],
    stderr=subprocess.DEVNULL, check=True,
)
print("wrote", OUT)
