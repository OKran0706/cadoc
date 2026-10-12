import jwt
import time
import sys

payload = {'sub': 'admin', 'iat': int(time.time()), 'exp': int(time.time()) + 3600}
token = jwt.encode(payload, 'test-secret', algorithm='HS256')
print(token if isinstance(token, str) else token.decode())
