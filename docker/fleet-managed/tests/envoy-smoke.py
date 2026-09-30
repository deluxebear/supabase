#!/usr/bin/env python3
"""Read-only gateway smoke checks; credentials stay in process memory."""
import argparse
import base64
import json
import os
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--container', required=True)
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--function', default='hello-world')
args = parser.parse_args()
container = json.loads(subprocess.check_output(['docker', 'inspect', args.container]))[0]
env = dict(value.split('=', 1) for value in container['Config']['Env'])
anon = env.get('SUPABASE_ANON_KEY') or env['ANON_KEY']
service = env.get('SUPABASE_SERVICE_KEY') or env['SERVICE_ROLE_KEY']
public = env.get('SUPABASE_PUBLISHABLE_KEY', '')
opaque = []
if env.get('FLEET_API_KEYS_MANAGED') == 'true':
    for index, item in enumerate(filter(None, env.get('FLEET_API_KEYS', '').split(','))):
        key, role = item.split('=', 1)
        opaque.append((f'{role}-{index}', key, role))
else:
    if public:
        opaque.append(('publishable', public, 'publishable'))
    if env.get('SUPABASE_SECRET_KEY'):
        opaque.append(('secret', env['SUPABASE_SECRET_KEY'], 'secret'))
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
checks = [
    ('auth-anon', '/auth/v1/settings', anon, None, 200),
    ('invalid-key', '/auth/v1/settings', 'invalid-smoke-key', None, 401),
    ('auth-admin', '/auth/v1/admin/users?page=1&per_page=1', service, service, 200),
    ('rest-openapi', '/rest/v1/', service, service, 200),
    ('storage', '/storage/v1/bucket', service, service, 200),
    ('realtime-admin-blocked', '/realtime/v1/api/tenants/realtime-dev/health', service, service, 403),
    ('function-revision', '/functions/v1/__fleet_probe/' + args.function, service, service, 204),
]
for name, key, role in opaque:
    checks.append((f'auth-{name}', '/auth/v1/settings', key, None, 200))
    checks.append((f'role-{name}', '/auth/v1/admin/users?page=1&per_page=1', key, key, 200 if role == 'secret' else 403))
    if role == 'secret' and env.get('FLEET_API_KEYS_MANAGED') == 'true':
        checks.append((f'function-{name}', '/functions/v1/__fleet_probe/' + args.function, key, key, 204))
failed = False
for name, path, key, bearer, expected in checks:
    headers = {'apikey': key}
    if bearer:
        headers['Authorization'] = 'Bearer ' + bearer
    request = urllib.request.Request(f'http://127.0.0.1:{args.port}' + path, headers=headers)
    try:
        with opener.open(request, timeout=10) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    print(f'{name}: {status} (expected {expected})')
    failed |= status != expected

for name, key in [('legacy', anon)] + [(name, key) for name, key, role in opaque]:
    path = '/realtime/v1/websocket?' + urllib.parse.urlencode({'apikey': key, 'vsn': '1.0.0'})
    ws_key = base64.b64encode(os.urandom(16)).decode()
    request = '\r\n'.join([
        f'GET {path} HTTP/1.1', f'Host: localhost:{args.port}', 'Connection: Upgrade',
        'Upgrade: websocket', f'Sec-WebSocket-Key: {ws_key}', 'Sec-WebSocket-Version: 13', '', '',
    ])
    with socket.create_connection(('127.0.0.1', args.port), timeout=10) as connection:
        connection.sendall(request.encode())
        status = int(connection.recv(4096).split(b'\r\n', 1)[0].split()[1])
    print(f'realtime-websocket-{name}: {status} (expected 101)')
    failed |= status != 101
raise SystemExit(1 if failed else 0)
