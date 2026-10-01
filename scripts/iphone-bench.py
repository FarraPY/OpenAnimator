"""(iPhone por cable, ver CLAUDE.md) Exporta un tramo de «Prueba de render» en el iPhone con distintos ajustes y mide los fps (del registro en vivo).
  python scripts/iphone-bench.py '<json de corridas>'   cada corrida: {"name", "workers", "prefs", "start", "end"} (y "project", "timeline": por defecto «Prueba de render»)"""
import json, os, re, subprocess, sys, time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.tools')
LOG = os.path.join(ROOT, '..', 'registro-iphone.log')
IOS = os.path.join(ROOT, 'go-ios', 'ios.exe')


def ev(js):
    env = dict(os.environ, MSYS_NO_PATHCONV='1')
    r = subprocess.run([IOS, 'webinspector', 'eval', '1', js, '--timeout=20'], capture_output=True, text=True, env=env, encoding='utf-8', errors='replace')
    return r.stdout.strip()


def run(c):
    prefs = json.dumps(c.get('prefs', {}))
    js = (f"localStorage.setItem('oa.capWorkers', '{c.get('workers', 3)}'); localStorage.setItem('oa.capPrefs', {json.dumps(prefs)});"
          f"oa.call('export:start', {{projectId: '{c.get('project', 'mi-video-2')}', timeline: '{c.get('timeline', 'prueba-render')}', range: {{start: {c['start']}, end: {c['end']}}},"
          f" width: 1920, height: 1080, fps: 30, codec: 'avc', quality: 'high', audio: false, audioBitrate: 192, name: 'bench-{c['name']}'}})"
          f".then((id) => window.__bench = id, (e) => window.__bench = 'error ' + e), 'ok'")
    n0 = sum(1 for _ in open(LOG, encoding='utf-8', errors='replace'))
    t0 = time.time()
    ev(js)
    while time.time() - t0 < 900:
        time.sleep(3)
        lines = open(LOG, encoding='utf-8', errors='replace').read().splitlines()[n0:]
        txt = '\n'.join(lines)
        if 'listo: Exportación terminada' in txt or re.search(r'exportar\] error', txt) or 'cancelado:' in txt:
            break
    frames = [l for l in lines if 'Fotograma' in l and '[exportar]' in l]
    last = frames[-1] if frames else ''
    m = re.search(r'Fotograma (\d+) de (\d+).*?([\d.]+) fps.*?van ([\d.]+) s', last)
    err = [l for l in lines if 'ERROR' in l or 'error' in l.lower() and 'exportar' in l]
    return {'name': c['name'], 'frames': m and m.group(1), 'fps': m and float(m.group(3)), 'secs': m and float(m.group(4)), 'err': err[:2]}


if __name__ == '__main__':
    out = []
    for c in json.loads(sys.argv[1]):
        r = run(c)
        print(json.dumps(r, ensure_ascii=False), flush=True)
        out.append(r)
        time.sleep(4)
