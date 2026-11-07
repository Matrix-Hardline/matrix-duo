#!/usr/bin/python3 -I
"""duo-osk-layout: Matrix keyboard layout (Swiss QWERTZ, app #27 matrix-keyboard) as a GNOME Shell OSK layout.
Overrides /org/gnome/shell/osk-layouts/ch.json via our own GResource, which the duo-osk extension registers at
startup (the last registered resource wins). Special keys are taken over from the original ch.json,
so that symbols and actions match exactly. Run (as root): duo-osk-layout.py  -> /usr/local/share/duo-osk/"""
import json, os, subprocess, sys, copy

OUT = "/usr/local/share/duo-osk"
SRC = "/usr/share/gnome-shell/gnome-shell-osk-layouts.gresource"

orig = json.loads(subprocess.run(["gresource", "extract", SRC, "/org/gnome/shell/osk-layouts/ch.json"],
                                 capture_output=True, text=True, check=True).stdout)
lv0 = orig["levels"][0]
def find(action=None, keyval=None, rows=lv0["rows"]):
    for r in rows:
        for k in r:
            if isinstance(k, dict) and ((action and k.get("action") == action) or (keyval and k.get("keyval") == keyval)):
                return copy.deepcopy(k)
    raise SystemExit("Taste nicht gefunden: %s %s" % (action, keyval))

delete = find(action="delete"); enter = find(keyval="0xff0d"); hide = find(action="hide"); shift = find(action="levelSwitch")
for k in (delete, enter, hide, shift):
    k.pop("width", None)

# Long-press variants (Matrix has none; obvious ones for Switzerland)
VAR = {"a": ["a", "à", "â", "æ"], "e": ["e", "é", "è", "ê", "ë"], "i": ["i", "î", "ï"], "o": ["o", "ô", "œ"],
       "u": ["u", "ù", "û"], "c": ["c", "ç"], "n": ["n", "ñ"], "y": ["y", "ÿ"], "s": ["s", "ś"]}

def chars(s, upper=False):
    out = []
    for ch in s:
        strings = VAR.get(ch, [ch])
        if upper:
            strings = [x.upper() for x in strings]
        out.append({"strings": strings})
    return out

def key(d, **kw):
    k = copy.deepcopy(d); k.update(kw); return k

def bottom(switch_label, switch_level):
    return [{"action": "levelSwitch", "label": switch_label, "level": switch_level, "width": 1.5},
            {"strings": [","]}, {"strings": [" "], "width": 4}, {"strings": ["."]},
            key(enter, width=2), key(hide)]

def letters(upper):
    sh = key(shift, level="default" if upper else "shift", width=1.5)
    return [chars("qwertzuiopü", upper), chars("asdfghjklöä", upper),
            [sh] + chars("yxcvbnm", upper) + [key(delete, width=1.5)],
            bottom("?123", "opt")]

# Digits/symbols page after the Swiss style guide (Federal Chancellery): « » as primary keys (» « not allowed),
# ’ for thousands (glibc de_CH), en dash for «Fr. 20.–», CHF/Fr. as a key; long press for ‹ › „ “ — etc.
def s(primary, *variants):
    return {"strings": [primary, *variants]}
digits = [
    [s("1"), s("2"), s("3"), s("4"), s("5"), s("6"), s("7"), s("8"), s("9"), s("0"), s("’", "'", "\u202f")],
    [s("-", "–", "—"), s("/", "\\"), s(":"), s(";"), s("("), s(")"), s("«", "‹"), s("»", "›"),
     s("\"", "„", "“", "”", "‹", "›"), s("@"), s("&")],
    [{"strings": ["CHF", "Fr.", "€", "$"], "label": "CHF", "width": 1.5}, s("="), s("+"), s("*", "×", "·"),
     s("%", "‰"), s("!", "¡"), s("?", "¿"), s("#"), key(delete, width=1.5)],
    bottom("ABC", "default")]

layout = {"locale": "de-CH", "name": "Swiss German (Matrix)", "levels": [
    {"level": "default", "mode": "default", "rows": letters(False)},
    {"level": "shift", "mode": "latched", "rows": letters(True)},
    {"level": "opt", "mode": "locked", "rows": digits},
]}

# Purpose layouts: for address/e-mail fields GNOME loads fixed url.json/email.json, and in the terminal «<group>-extended»
# (all US QWERTY only, 31.10.: y/z swapped in the Files address field and in the terminal). Derived from the GNOME templates:
# y<->z as on a Swiss keyboard, umlauts + accents via long press; function keys (www., @, Tab, Ctrl, arrows) stay.
SWAP = {"y": "z", "z": "y", "Y": "Z", "Z": "Y"}
UML = {"a": "ä", "o": "ö", "u": "ü"}
def swiss(model):
    m = copy.deepcopy(model)
    m["locale"] = "de-CH"
    for lvl in m["levels"]:
        for row in lvl["rows"]:
            for k in row:
                st = k.get("strings") if isinstance(k, dict) else None
                if not st or len(st[0]) != 1 or not st[0].isalpha():
                    continue
                c = SWAP.get(st[0], st[0])
                low = c.lower()
                variants = list(VAR.get(low, [low]))
                if low in UML:
                    variants.insert(1, UML[low])
                if c.isupper():
                    variants = [v.upper() for v in variants]
                k["strings"] = variants
                k.pop("label", None)
    return m

def gnome(name):
    return json.loads(subprocess.run(["gresource", "extract", SRC, "/org/gnome/shell/osk-layouts/%s.json" % name],
                                     capture_output=True, text=True, check=True).stdout)

extra = {"url.json": swiss(gnome("url")), "email.json": swiss(gnome("email")),
         "ch-extended.json": swiss(gnome("us-extended"))}
extra["ch-extended.json"]["name"] = "Swiss German (Matrix, Terminal)"

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "ch.json"), "w") as f:
    json.dump(layout, f, ensure_ascii=False, indent=1)
for fn, model in extra.items():
    with open(os.path.join(OUT, fn), "w") as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
files = ["ch.json"] + list(extra)
with open(os.path.join(OUT, "duo-osk.gresource.xml"), "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<gresources>\n  <gresource prefix="/org/gnome/shell/osk-layouts">\n' +
            "".join("    <file>%s</file>\n" % fn for fn in files) + '  </gresource>\n</gresources>\n')
# first into a new file, then rename: the shell keeps the old resource mapped (overwriting -> SIGBUS)
tmp = os.path.join(OUT, "duo-osk-layouts.gresource.neu")
subprocess.run(["glib-compile-resources", "--sourcedir", OUT, "--target", tmp,
                os.path.join(OUT, "duo-osk.gresource.xml")], check=True)
os.replace(tmp, os.path.join(OUT, "duo-osk-layouts.gresource"))
print("duo-osk-layouts.gresource: %d Bytes" % os.path.getsize(os.path.join(OUT, "duo-osk-layouts.gresource")))
