"""Inline lib/ into one self-contained page: explorer.html.

index.html loads lib/*.js as ES modules, which browsers refuse from file://.
explorer.html has the same page with the modules bundled into its inline
script, so it also works when opened straight from disk or a file preview.
Re-run after changing index.html or lib/:  python3 dev/build_standalone.py
Needs esbuild (npx esbuild, or npm i esbuild).
"""
import os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "index.html")).read()
m = re.search(r'<script type="module">\n(.*?)</script>', src, re.S)
bundle = subprocess.run(
    ["npx", "--yes", "esbuild", "--bundle", "--format=esm", "--charset=ascii",
     "--loader=js", "--sourcefile=page.js"],
    input=m.group(1), capture_output=True, text=True, cwd=ROOT, check=True).stdout
note = ("<!-- GENERATED from index.html + lib/ by dev/build_standalone.py; "
        "edit those, not this file. -->\n")
out = src[:m.start(1)] + bundle + src[m.end(1):]
out = out.replace("<head>\n", "<head>\n" + note, 1)
open(os.path.join(ROOT, "explorer.html"), "w").write(out)
print("wrote explorer.html", len(out), "bytes")
