#!/usr/bin/env python3
"""Render a markdown report to a styled PDF in the Flare Registry house style.

  python3 scripts/build-report-pdf.py <input.md> [output.pdf]

Generalised from build-ff-pdf.py, which is hardcoded to one document and carries a bespoke
statistics callout. Same markdown subset, same CSS, same headless-Chrome rendering, so anything
produced here sits alongside the existing collateral rather than looking like a second house style.
"""
import re, html, subprocess, os, base64, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else None
if not SRC:
    sys.exit("usage: build-report-pdf.py <input.md> [output.pdf]")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(SRC)[0] + ".pdf"
LOGO = "public/logo-wordmark.v2.png"
# WATERMARK="Draft" stamps every page. Opt-in, because a watermark left on by accident is worse than
# none: it is the kind of thing that gets ignored as decoration and then ships on the final copy.
WATERMARK = os.environ.get("WATERMARK", "").strip()

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
        t = "<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in header) + "</tr></thead><tbody>"
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
    # Blockquote. Absent before, so a "> ..." line rendered as literal prose with the marker visible
    # and the wrapping mangled, which is a poor way to present text one is quoting verbatim.
    if first.lstrip().startswith(">"):
        quoted = " ".join(re.sub(r"^\s*>\s?", "", ln).strip() for ln in bl)
        parts.append(f"<blockquote>{inline(quoted)}</blockquote>"); continue
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

css = """
@page { margin: 20mm 18mm; }
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#222;line-height:1.45;font-size:13.5px}
h1{font-size:26px;color:#1a1a1a;margin:0 0 4px;font-weight:700;letter-spacing:-.3px;line-height:1.2}
h2{font-size:17.5px;margin:26px 0 9px;color:#1a1a1a;font-weight:700;border-left:4px solid #f5a623;padding-left:10px;line-height:1.25;break-after:avoid}
h3{font-size:14px;margin:18px 0 5px;color:#444;font-weight:700;line-height:1.3;break-after:avoid}
p{margin:9px 0;line-height:1.45}
blockquote{margin:12px 0;padding:8px 0 8px 14px;border-left:3px solid #f5a623;color:#444;font-style:italic;background:#fffdf8;break-inside:avoid}
blockquote code{font-style:normal}
.note{color:#888;font-size:12px;font-style:italic;border-top:1px solid #eee;padding-top:10px;line-height:1.5}
table{border-collapse:collapse;width:100%;margin:13px 0;font-size:12px;break-inside:avoid}
th,td{border:1px solid #e3e3e3;padding:7px 10px;text-align:left;vertical-align:top;line-height:1.35}
th{background:#faf3e6;font-weight:700;color:#7a4d08}
tr:nth-child(even) td{background:#fafafa}
code{background:#f3f3f3;padding:1px 3px;border-radius:3px;font-size:11.5px;color:#9a3b3b}
hr{border:none;border-top:1px solid #eee;margin:22px 0}
a{color:#b8740f;text-decoration:none;border-bottom:1px solid #e9cfa0}
ul,ol{margin:8px 0;padding-left:22px}
li{margin:5px 0;line-height:1.45}
strong{color:#111}
.brand{margin-bottom:20px}
.brand img{height:34px;width:auto}
/* position:fixed repeats on every printed page in Chrome, which is what makes one element enough.
   Behind the text via z-index, and non-selectable so copy-paste out of the PDF stays clean. */
.watermark{position:fixed;top:50%;left:50%;
  transform:translate(-50%,-50%) rotate(-38deg);
  font-size:150px;font-weight:800;letter-spacing:14px;
  color:rgba(180,116,15,.10);
  z-index:0;pointer-events:none;user-select:none;white-space:nowrap}
.page-content{position:relative;z-index:1}
"""

# NO_LOGO=1 suppresses the wordmark. Governance proposals put to a vote of a body we are only one
# member of should not carry our branding at the top: the argument has to stand on its own, and a
# logo on a document asking others to vote reads as a house position rather than a proposal.
brand = ""
if os.path.exists(LOGO) and os.environ.get("NO_LOGO") != "1":
    logo_b64 = base64.b64encode(open(LOGO, "rb").read()).decode()
    brand = f'<div class="brand"><img src="data:image/png;base64,{logo_b64}" alt="Flare Registry"></div>'

mark = f'<div class="watermark">{html.escape(WATERMARK)}</div>' if WATERMARK else ""

tmp = "/tmp/report-%d.html" % os.getpid()
open(tmp, "w").write(
    f'<html><head><meta charset="utf-8"><style>{css}</style></head>'
    f'<body>{mark}<div class="page-content">{brand}{body}</div></body></html>'
)
# Guard against the converter silently leaving markdown in the output.
rendered = open(tmp).read()
assert rendered.count("**") == 0, "stray ** in output"

chrome = next((c for c in ("google-chrome", "chromium", "chromium-browser")
               if subprocess.run(["which", c], capture_output=True).returncode == 0), None)
if not chrome:
    sys.exit("no chrome/chromium found for PDF rendering")

subprocess.run(
    [chrome, "--headless", "--disable-gpu", "--no-sandbox",
     "--print-to-pdf=" + os.path.abspath(OUT), "--no-pdf-header-footer", tmp],
    stderr=subprocess.DEVNULL, check=True,
)
os.remove(tmp)
print("wrote", OUT, "(%.0f KB)" % (os.path.getsize(OUT) / 1024))
