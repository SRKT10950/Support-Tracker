import requests
import re
import json

r = requests.get('https://db.mhservice.co.in/', timeout=5)
print("Title:", re.findall(r'<title>(.*?)</title>', r.text))
print("APIs:", set(re.findall(r'/API/[a-zA-Z0-9_/]+', r.text)))

# Also check scripts
scripts = re.findall(r'src=["\']([^"\']+\.js[^"\']*)["\']', r.text)
print("Scripts:", scripts)
