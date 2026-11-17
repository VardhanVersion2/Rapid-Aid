import re

with open('public/app.js', 'r', encoding='utf-8') as f:
    js_code = f.read()

with open('public/index.html', 'r', encoding='utf-8') as f:
    html_code = f.read()

dollar_ids = set(re.findall(r"\$\(['\"]([^'\"]+)['\"]\)", js_code))
html_ids = set(re.findall(r'id=["\']([^"\']+)["\']', html_code))

missing = []
for d_id in sorted(dollar_ids):
    if d_id not in html_ids:
        missing.append(d_id)

print("Missing IDs count:", len(missing))
for m in missing:
    print(" -", m)

