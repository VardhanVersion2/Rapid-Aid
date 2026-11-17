import re

with open('public/responder.js', 'r', encoding='utf-8') as f:
    js_code = f.read()

with open('public/responder.html', 'r', encoding='utf-8') as f:
    html_code = f.read()

dollar_ids = set(re.findall(r"\$\(['\"]([^'\"]+)['\"]\)", js_code))
html_ids = set(re.findall(r'id=["\']([^"\']+)["\']', html_code))

missing = []
for d_id in sorted(dollar_ids):
    # Some IDs are dynamically generated like audio-wrap-xxx or photo-wrap-xxx
    if d_id not in html_ids and not d_id.startswith('audio-wrap-') and not d_id.startswith('photo-wrap-'):
        missing.append(d_id)

print("Responder Missing IDs count:", len(missing))
for m in missing:
    print(" -", m)

