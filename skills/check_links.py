"""Verify no broken relative links remain in byeppt-deck markdown."""
import os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.join(ROOT, 'byeppt-deck')
BSLASH = chr(92)
broken = []
link_re = re.compile(r'\]\(([^)#\s]+)(?:#[^)]*)?\)')
read_re = re.compile(r'(?:Read|read_file)\s+`?((?:references|templates|workflows)/[^\s`]+)')
for root, dirs, files in os.walk(DECK):
    for f in files:
        if not f.endswith('.md'):
            continue
        p = os.path.join(root, f)
        text = open(p, encoding='utf-8').read()
        for m in link_re.finditer(text):
            url = m.group(1)
            if '://' in url:
                continue
            if not os.path.exists(os.path.normpath(os.path.join(root, url))):
                broken.append((p, url))
        for m in read_re.finditer(text):
            frag = m.group(1)
            tgt = os.path.normpath(os.path.join(ROOT, 'byeppt-deck', frag))
            if '<' in frag:  # parameterized path: check the static prefix dir
                prefix = frag.split('<')[0].rstrip('/')
                if prefix and not os.path.exists(os.path.normpath(os.path.join(ROOT, 'byeppt-deck', prefix))):
                    broken.append((p, frag))
            elif not os.path.exists(tgt):
                broken.append((p, frag))
seen = set()
for p, u in broken:
    k = (p.replace(ROOT + BSLASH, ''), u)
    if k in seen:
        continue
    seen.add(k)
    print(k[0], '->', u)
print('BROKEN:', len(seen))
