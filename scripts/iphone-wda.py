"""Manejar el iPhone por cable con WebDriverAgent (ver CLAUDE.md › «iPhone por cable»: go-ios con tunnel start
--userspace, runwda y forward 8100).
  python scripts/iphone-wda.py shot [archivo.png] | size | tap x y | hold x y [s] | swipe x1 y1 x2 y2 [s] | type texto
                   home | launch <bundle> | source | click <nombre>
Coordenadas en puntos de iOS (la captura viene en píxeles: en el iPhone 17 Pro Max, 3 píxeles por punto)."""
import base64, json, sys, urllib.request

WDA = 'http://127.0.0.1:8100'


def req(method, path, body=None):
    r = urllib.request.Request(WDA + path, method=method, headers={'Content-Type': 'application/json'},
                               data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(r, timeout=120) as f:
        return json.load(f)


def sid():
    return req('GET', '/status').get('sessionId') or req('POST', '/session', {'capabilities': {'alwaysMatch': {}}})['sessionId']


def touch(*steps):
    req('POST', f'/session/{sid()}/actions', {'actions': [{'type': 'pointer', 'id': 'dedo', 'parameters': {'pointerType': 'touch'}, 'actions': list(steps)}]})


def move(x, y, ms=0):
    return {'type': 'pointerMove', 'duration': ms, 'x': round(float(x)), 'y': round(float(y))}


def main(cmd, *a):
    if cmd == 'shot':
        out = a[0] if a else 'shots/pantalla.png'
        open(out, 'wb').write(base64.b64decode(req('GET', '/screenshot')['value']))
        print(out)
    elif cmd == 'size':
        print(req('GET', f'/session/{sid()}/window/size')['value'])
    elif cmd == 'tap':
        touch(move(a[0], a[1]), {'type': 'pointerDown', 'button': 0}, {'type': 'pause', 'duration': 60}, {'type': 'pointerUp', 'button': 0})
    elif cmd == 'hold':
        touch(move(a[0], a[1]), {'type': 'pointerDown', 'button': 0}, {'type': 'pause', 'duration': int(float(a[2] if len(a) > 2 else 1) * 1000)}, {'type': 'pointerUp', 'button': 0})
    elif cmd == 'swipe':
        ms = int(float(a[4] if len(a) > 4 else 0.3) * 1000)
        touch(move(a[0], a[1]), {'type': 'pointerDown', 'button': 0}, move(a[2], a[3], ms), {'type': 'pointerUp', 'button': 0})
    elif cmd == 'type':
        req('POST', f'/session/{sid()}/wda/keys', {'value': list(' '.join(a))})
    elif cmd == 'home':
        req('POST', '/wda/homescreen')
    elif cmd == 'launch':
        req('POST', f'/session/{sid()}/wda/apps/launch', {'bundleId': a[0]})
    elif cmd == 'click':
        # Un botón o fila por su nombre de accesibilidad (espera hasta 10 s a que aparezca).
        import time
        name = ' '.join(a)
        for _ in range(20):
            try:
                el = req('POST', f'/session/{sid()}/element', {'using': 'predicate string', 'value': f"label == '{name}' OR name == '{name}'"})['value']
                req('POST', f"/session/{sid()}/element/{el['ELEMENT']}/click", {})
                return
            except Exception:
                time.sleep(0.5)
        sys.exit(f'No apareció «{name}»')
    elif cmd == 'source':
        print(req('GET', '/source?format=description')['value'])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(*(sys.argv[1:] or ['?']))
