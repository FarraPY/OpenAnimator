"""Memoria de OpenAnimator en el iPhone conectado por cable, en vivo: los procesos del motor web
(com.apple.WebKit.WebContent) del grupo de la app —la interfaz y la vista previa (NativePreview.swift), cada uno con su
límite— y la GPU de WebKit. Escribe una línea cuando el más grande cambia 20 MB o más.
iOS cierra el motor web al pasar ~2 GB (los JetsamEvent dicen «per-process-limit» con 2048–2303 MB).
  .tools/pmd3/Scripts/python.exe scripts/iphone-mem.py [registro.log]
Necesita pymobiledevice3 (abre su propio túnel sin permisos de administrador) y la imagen de desarrollador montada."""
import asyncio, sys, time

from pymobiledevice3.remote.userspace_tunnel import establish_userspace_rsd
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.sysmontap import Sysmontap

MB = 2 ** 20


async def main(out):
    rsd = await establish_userspace_rsd()
    async with DvtProvider(rsd) as dvt, await Sysmontap.create(dvt, interval=1000) as sysmon:
        last, peak = None, 0.0
        async for procs in sysmon.iter_processes():
            app = next((p for p in procs if p.get('name') == 'OpenAnimator'), None)
            if not app:
                continue
            mine = [p for p in procs if p.get('coalitionID') == app.get('coalitionID')]
            webs = sorted((p for p in mine if p.get('name') == 'com.apple.WebKit.WebContent'), key=lambda p: -p.get('physFootprint', 0))
            gpu = sum(p.get('physFootprint', 0) for p in mine if p.get('name') == 'com.apple.WebKit.GPU') / MB
            web = webs[0].get('physFootprint', 0) / MB if webs else 0
            peak = max(peak, web)
            if last is None or abs(web - last) >= 20:
                last = web
                todos = ' + '.join(f"{p.get('physFootprint', 0) / MB:.0f}" for p in webs)
                line = f"{time.strftime('%H:%M:%S')} motor web {web:5.0f} MB (pid {webs[0]['pid'] if webs else '-'}, pico {peak:.0f}; todos: {todos}) · GPU {gpu:4.0f} MB"
                print(line, flush=True)
                if out:
                    out.write(line + '\n')
                    out.flush()


if __name__ == '__main__':
    asyncio.run(main(open(sys.argv[1], 'a', encoding='utf-8') if len(sys.argv) > 1 else None))
