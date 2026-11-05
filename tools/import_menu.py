#!/usr/bin/env python3
"""Týdenní import menu eBistra ze Sebou do index.html.

Stáhne aktuální nabídku z api.sebou.cz, vezme jen kategorie dnů v týdnu
("PONDĚLÍ 12.10.2026" apod.), přepíše zálohu MENU_SNAPSHOT v index.html
a stáhne fotky jídel do složky menu/. Staré fotky ze složky menu/ smaže.

Použití: python3 import_menu.py [cesta/k/ebistro-web]
Vypíše JSON se shrnutím (week, days, changed).
"""
import json, os, re, sys, urllib.request

API = "https://api.sebou.cz/v1/?request=get_store_initial&store_slug=ebistro"
IMG = "https://api.sebou.cz/uploads/products/"
DAY = re.compile(r"^(PONDĚLÍ|ÚTERÝ|STŘEDA|ČTVRTEK|PÁTEK|SOBOTA|NEDĚLE)\s+\d", re.I)
SNAP = re.compile(r"var MENU_SNAPSHOT = \{.*?\};\n")

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ebistro-menu-import"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def main(root):
    data = json.loads(get(API))
    cats = [c for c in data.get("product_categories", []) if DAY.match(c.get("name", ""))]
    ids = {c["id"] for c in cats}
    products = [{k: p.get(k) for k in ("name", "description", "price", "allergens", "id_category", "images")}
                for p in data.get("products", []) if p.get("id_category") in ids]
    snapshot = {"product_categories": [{k: c[k] for k in ("id", "name", "position")} for c in cats],
                "products": products}

    index = os.path.join(root, "index.html")
    html = open(index, encoding="utf-8").read()
    if not SNAP.search(html):
        sys.exit("V index.html chybí řádek var MENU_SNAPSHOT")
    line = "var MENU_SNAPSHOT = " + json.dumps(snapshot, ensure_ascii=False) + ";\n"
    new_html = SNAP.sub(lambda m: line, html, count=1)
    changed = new_html != html
    if changed:
        open(index, "w", encoding="utf-8").write(new_html)

    menu_dir = os.path.join(root, "menu")
    os.makedirs(menu_dir, exist_ok=True)
    wanted = {p["images"]["medium"] for p in products if p.get("images") and p["images"].get("medium")}
    for f in wanted:
        path = os.path.join(menu_dir, f)
        if not os.path.exists(path):
            open(path, "wb").write(get(IMG + f))
            changed = True
    # Lehčí kopie fotek pro mobil (WebP). Když chybí Pillow, web použije PNG.
    keep = set(wanted)
    try:
        from PIL import Image
        for f in wanted:
            w = os.path.splitext(f)[0] + ".webp"
            keep.add(w)
            wpath = os.path.join(menu_dir, w)
            if not os.path.exists(wpath):
                Image.open(os.path.join(menu_dir, f)).convert("RGB").save(wpath, "WEBP", quality=80, method=6)
                changed = True
    except ImportError:
        pass
    for f in os.listdir(menu_dir):
        if f not in keep:
            os.remove(os.path.join(menu_dir, f))
            changed = True

    print(json.dumps({"days": [c["name"] for c in cats],
                      "dishes": [p["name"] for p in products],
                      "photos": sorted(wanted), "changed": changed}, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
