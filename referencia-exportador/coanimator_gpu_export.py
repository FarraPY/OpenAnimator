"""
CoAnimator GPU Export
---------------------
Exporta proyectos de CoAnimator y codifica el resultado final con la GPU NVIDIA
(NVENC: H.264 / HEVC / AV1, decodificación NVDEC).

Flujo:
  1. CoAnimator (CLI oculto `CoAnimator.exe --cli render`) captura los fotogramas
     de cada timeline, partido en segmentos. Cada segmento terminado queda
     guardado: si se corta la luz o se cancela, al volver a iniciar se retoma
     donde quedó.
  2. FFmpeg une los segmentos y codifica el video final con NVENC con todas las
     opciones elegidas (códec, bitrate, resolución, fps, audio, capítulos...).

Solo usa la librería estándar de Python + FFmpeg (que CoAnimator ya requiere).
"""
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

APP_TITLE = "CoAnimator GPU Export"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".coanimator_gpu_export.json")
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

# ── Opciones ──────────────────────────────────────────────────────────────────
VCODECS = {
    "H.264 (NVENC)": "h264_nvenc",
    "HEVC / H.265 (NVENC)": "hevc_nvenc",
    "AV1 (NVENC)": "av1_nvenc",
    "Copiar sin recodificar": "copy",
}
PRESETS_NV = ["p1 (más rápido)", "p2", "p3", "p4 (medio)", "p5", "p6", "p7 (mejor calidad)"]
TUNES = ["hq (alta calidad)", "uhq (ultra calidad, solo HEVC/AV1)", "ll (baja latencia)",
         "ull (ultra baja latencia)", "lossless (sin pérdida)"]
RATECTRL = ["Calidad constante (CQ)", "Bitrate variable (VBR)", "Bitrate constante (CBR)",
            "QP constante (CQP)", "Tamaño objetivo (MB)", "Sin pérdida"]
MULTIPASS = {"Desactivado": "disabled", "2 pasadas (cuarto de resolución)": "qres",
             "2 pasadas (resolución completa)": "fullres"}
PIXFMTS = {  # nombre: (pix_fmt, perfil h264, perfil hevc, perfil av1)
    "8 bits 4:2:0 (máxima compatibilidad)": ("yuv420p", "high", "main", "main"),
    "10 bits 4:2:0 (menos banding)": ("p010le", "high10", "main10", "main"),
    "8 bits 4:2:2 (RTX 50)": ("yuv422p", "high422", "rext", None),
    "10 bits 4:2:2 (RTX 50)": ("p210le", "high422", "rext", None),
    "8 bits 4:4:4 (color completo)": ("yuv444p", "high444p", "rext", None),
}
RESOLUTIONS = {
    "Original": None, "3840x2160 (4K UHD)": (3840, 2160), "2560x1440 (2K QHD)": (2560, 1440),
    "1920x1080 (Full HD)": (1920, 1080), "1280x720 (HD)": (1280, 720), "854x480 (SD)": (854, 480),
    "640x360": (640, 360), "1080x1920 (vertical)": (1080, 1920), "1080x1080 (cuadrado)": (1080, 1080),
    "Personalizada": "custom",
}
FITS = ["Mantener proporción (barras negras)", "Recortar para llenar", "Estirar"]
SCALERS = {"Lanczos (más nítido)": "lanczos", "Bicúbico": "bicubic", "Bilineal (rápido)": "bilinear",
           "Spline": "spline"}
SHARPEN = {"Ninguna": None, "Suave": "5:5:0.35:5:5:0", "Media": "5:5:0.7:5:5:0", "Fuerte": "5:5:1.1:5:5:0"}
FPS_OUT = ["Original", "23.976", "24", "25", "29.97", "30", "48", "50", "59.94", "60", "120"]
COLORS = {"BT.709 (HD, recomendado)": "bt709", "BT.601 (SD)": "smpte170m", "Sin etiquetar": None}
RANGES = {"Limitado (TV, estándar)": "tv", "Completo (PC)": "pc"}
ACODECS = {
    "AAC": "aac", "MP3": "libmp3lame", "Opus": "libopus", "AC3 (Dolby Digital)": "ac3",
    "FLAC (sin pérdida)": "flac", "PCM 16 bits (WAV)": "pcm_s16le", "PCM 24 bits": "pcm_s24le",
    "Copiar sin recodificar": "copy", "Sin audio": None,
}
ABITRATES = ["64", "96", "128", "160", "192", "256", "320", "384", "448", "512"]
ARATES = ["Original", "44100", "48000", "96000"]
ACHANNELS = {"Original": None, "Mono": 1, "Estéreo": 2, "5.1": 6}
CONTAINERS = {"MP4": "mp4", "MKV": "mkv", "MOV": "mov", "WEBM (solo AV1 + Opus)": "webm"}

RENDER_RES = ["720p", "1080p", "4k"]
RENDER_QUALITY = ["max", "high", "standard", "low"]
RENDER_ENGINES = ["standard", "single-pass", "experimental-1"]
RENDER_WORKERS = ["auto", "1", "2", "4", "6", "8", "10", "12", "16", "20"]
RENDER_MODES = ["quick", "efficient"]

DEFAULTS = {
    "src_mode": "proyecto", "project_path": "", "join_mode": "uno", "chapters": True,
    "seg_min": "10", "r_res": "720p", "r_fps": "30", "r_quality": "max", "r_engine": "standard",
    "r_workers": "auto", "r_mode": "quick", "r_start": "", "r_end": "", "keep_temp": False,
    "vcodec": "H.264 (NVENC)", "preset": "p5", "tune": TUNES[0], "rc": RATECTRL[0], "cq": "21",
    "qp": "22", "bitrate": "8000", "maxrate": "", "target_mb": "2000", "multipass": "2 pasadas (cuarto de resolución)",
    "pixfmt": list(PIXFMTS)[0], "out_res": "1920x1080 (Full HD)", "sharpen": "Suave", "custom_w": "1920", "custom_h": "1080",
    "fit": FITS[0], "scaler": "Lanczos (más nítido)", "out_fps": "Original", "bframes": "3",
    "gop_sec": "2", "lookahead": "20", "spatial_aq": True, "temporal_aq": True, "aq_strength": "8",
    "gpu_decode": True, "color": list(COLORS)[0], "range": list(RANGES)[0],
    "acodec": "AAC", "abitrate": "192", "arate": "48000", "achannels": "Original", "volume_db": "0",
    "loudnorm": False, "lufs": "-14",
    "container": "MP4", "out_dir": os.path.join(os.path.expanduser("~"), "Videos"), "out_name": "",
    "faststart": True, "title": "", "trim_start": "", "trim_end": "",
}

EXPORT_PRESETS = {
    "1080p desde render 720p (CoAnimator Free)": dict(vcodec="H.264 (NVENC)", preset="p6", tune=TUNES[0], rc=RATECTRL[0], cq="19",
        pixfmt=list(PIXFMTS)[0], out_res="1920x1080 (Full HD)", fit=FITS[0], scaler="Lanczos (más nítido)", sharpen="Suave",
        container="MP4", acodec="AAC", abitrate="192", arate="48000", r_res="720p"),
    "YouTube 1080p (H.264, alta calidad)": dict(vcodec="H.264 (NVENC)", preset="p6", tune=TUNES[0], rc=RATECTRL[0], cq="20",
        pixfmt=list(PIXFMTS)[0], out_res="Original", container="MP4", acodec="AAC", abitrate="256", arate="48000"),
    "YouTube 4K (HEVC 10 bits)": dict(vcodec="HEVC / H.265 (NVENC)", preset="p6", tune=TUNES[1], rc=RATECTRL[0], cq="22",
        pixfmt=list(PIXFMTS)[1], out_res="Original", container="MP4", acodec="AAC", abitrate="320", arate="48000"),
    "Archivo pequeño alta calidad (AV1 10 bits)": dict(vcodec="AV1 (NVENC)", preset="p7", tune=TUNES[1], rc=RATECTRL[0], cq="30",
        pixfmt=list(PIXFMTS)[1], container="MP4", acodec="AAC", abitrate="160"),
    "Web ligero 720p (H.264 VBR 2.5 Mbps)": dict(vcodec="H.264 (NVENC)", preset="p6", tune=TUNES[0], rc=RATECTRL[1], bitrate="2500",
        maxrate="4000", out_res="1280x720 (HD)", pixfmt=list(PIXFMTS)[0], container="MP4", acodec="AAC", abitrate="128"),
    "Redes / WhatsApp (H.264 720p CBR 1.5 Mbps)": dict(vcodec="H.264 (NVENC)", preset="p5", tune=TUNES[0], rc=RATECTRL[2], bitrate="1500",
        out_res="1280x720 (HD)", pixfmt=list(PIXFMTS)[0], container="MP4", acodec="AAC", abitrate="128", out_fps="30"),
    "Para editar (H.264 4:2:2 10 bits, keyframe cada 0.5 s)": dict(vcodec="H.264 (NVENC)", preset="p4", tune=TUNES[0], rc=RATECTRL[3], qp="16",
        pixfmt="10 bits 4:2:2 (RTX 50)", gop_sec="0.5", bframes="0", container="MOV", acodec="PCM 24 bits"),
    "Master sin pérdida (HEVC lossless)": dict(vcodec="HEVC / H.265 (NVENC)", preset="p7", tune=TUNES[4], rc=RATECTRL[5],
        pixfmt="8 bits 4:4:4 (color completo)", container="MKV", acodec="FLAC (sin pérdida)"),
    "Solo unir, sin recodificar (lo más rápido)": dict(vcodec="Copiar sin recodificar", acodec="Copiar sin recodificar", container="MP4"),
}


# ── Utilidades ────────────────────────────────────────────────────────────────
def find_ffmpeg(name="ffmpeg"):
    env = os.environ.get(f"{name.upper()}_PATH")
    if env and os.path.isfile(env):
        return env
    return shutil.which(name) or name


FFMPEG, FFPROBE = find_ffmpeg("ffmpeg"), find_ffmpeg("ffprobe")


def find_coanimator():
    cands = [os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "coanimator", "CoAnimator.exe"),
             os.path.join(os.environ.get("ProgramFiles", ""), "CoAnimator", "CoAnimator.exe")]
    return next((c for c in cands if os.path.isfile(c)), None)


def projects_dir():
    return os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "CoAnimator", "projects")


def load_project(path):
    """Devuelve (nombre, [ {id, name, duration, fps} ]) de una carpeta de proyecto."""
    with open(os.path.join(path, "project.json"), encoding="utf-8") as f:
        proj = json.load(f)
    tls = []
    for tl in proj.get("timelines") or [{"id": "main", "name": proj.get("name"), "file": "timeline.json"}]:
        dur, fps = proj.get("duration", 0), 30
        try:
            with open(os.path.join(path, tl["file"]), encoding="utf-8") as f:
                d = json.load(f)
            dur, fps = d.get("duration", dur), d.get("fps", 30) or 30
        except (OSError, ValueError, KeyError):
            pass
        tls.append({"id": tl["id"], "name": tl.get("name") or tl["id"], "duration": float(dur), "fps": float(fps)})
    return proj.get("name") or os.path.basename(path), tls


def probe_duration(path):
    try:
        out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of",
                              "default=nw=1:nk=1", path], capture_output=True, text=True,
                             creationflags=NO_WINDOW, timeout=60).stdout.strip()
        return float(out)
    except (ValueError, OSError, subprocess.TimeoutExpired):
        return 0.0


def fmt_time(sec):
    sec = max(0, int(sec))
    return f"{sec // 3600}:{sec // 60 % 60:02d}:{sec % 60:02d}"


def safe_name(s):
    return re.sub(r'[<>:"/\\|?*]+', "-", s).strip(" .") or "video"


def num(s, default=0.0):
    try:
        return float(str(s).replace(",", "."))
    except ValueError:
        return default


def kill_tree(proc):
    if proc and proc.poll() is None:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True,
                           creationflags=NO_WINDOW)
        else:
            proc.kill()


# ── Construcción del comando FFmpeg ───────────────────────────────────────────
def build_ffmpeg_cmd(c, inputs, output, duration, chapters_file=None, concat=False):
    """c: dict de configuración. inputs: archivo o lista concat. duration: seg. de la fuente."""
    vcodec, acodec = VCODECS[c["vcodec"]], ACODECS[c["acodec"]]
    ext = CONTAINERS[c["container"]]
    t0, t1 = num(c["trim_start"], 0), num(c["trim_end"], 0)
    out_dur = (t1 if t1 > 0 else duration) - t0

    cmd = [FFMPEG, "-hide_banner", "-y", "-nostdin", "-progress", "pipe:1", "-nostats"]
    if c["gpu_decode"] and vcodec != "copy":
        cmd += ["-hwaccel", "cuda"]
    if concat:
        cmd += ["-f", "concat", "-safe", "0"]
    cmd += ["-i", inputs]
    if chapters_file:
        cmd += ["-i", chapters_file]
    if t0 > 0:
        cmd += ["-ss", f"{t0:.3f}"]
    if t1 > 0:
        cmd += ["-to", f"{t1:.3f}"]
    cmd += ["-map", "0:v:0"]
    if acodec:
        cmd += ["-map", "0:a?"]
    if chapters_file:
        cmd += ["-map_metadata", "1", "-map_chapters", "1"]

    # Video
    if vcodec == "copy":
        cmd += ["-c:v", "copy"]
    else:
        pix, p264, phevc, pav1 = PIXFMTS[c["pixfmt"]]
        profile = {"h264_nvenc": p264, "hevc_nvenc": phevc, "av1_nvenc": pav1}[vcodec]
        if profile is None:
            raise ValueError("AV1 NVENC solo admite 4:2:0 (8 o 10 bits). Cambiá el formato de color.")
        tune = c["tune"].split()[0]
        if tune == "uhq" and vcodec == "h264_nvenc":
            tune = "hq"
        lossless = tune == "lossless" or c["rc"] == "Sin pérdida"
        if lossless:
            if vcodec == "av1_nvenc":
                raise ValueError("AV1 NVENC no tiene modo sin pérdida. Usá HEVC o H.264.")
            tune = "lossless"
        vf = []
        res = RESOLUTIONS[c["out_res"]]
        if res == "custom":
            res = (int(num(c["custom_w"], 1920)) // 2 * 2, int(num(c["custom_h"], 1080)) // 2 * 2)
        if res:
            w, h = res
            fl = SCALERS[c["scaler"]]
            if c["fit"] == FITS[0]:
                vf.append(f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags={fl},"
                          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black")
            elif c["fit"] == FITS[1]:
                vf.append(f"scale={w}:{h}:force_original_aspect_ratio=increase:flags={fl},crop={w}:{h}")
            else:
                vf.append(f"scale={w}:{h}:flags={fl}")
            vf.append("setsar=1")
        if SHARPEN.get(c.get("sharpen", "Ninguna")):
            vf.append(f"unsharp={SHARPEN[c['sharpen']]}")
        if c["out_fps"] != "Original":
            fps_map = {"23.976": "24000/1001", "29.97": "30000/1001", "59.94": "60000/1001"}
            vf.append(f"fps={fps_map.get(c['out_fps'], c['out_fps'])}")
        vf.append(f"format={pix}")
        cmd += ["-vf", ",".join(vf), "-c:v", vcodec, "-preset", c["preset"].split()[0],
                "-tune", tune]
        if vcodec != "av1_nvenc":  # av1_nvenc solo tiene perfil main y no acepta el nombre
            cmd += ["-profile:v", profile]

        rc = c["rc"]
        if lossless:
            cmd += ["-rc", "constqp", "-qp", "0"]
        elif rc == "Calidad constante (CQ)":
            cmd += ["-rc", "vbr", "-cq", str(int(num(c["cq"], 21))), "-b:v", "0"]
            if num(c["maxrate"]) > 0:
                cmd += ["-maxrate", f"{int(num(c['maxrate']))}k", "-bufsize", f"{int(num(c['maxrate']) * 2)}k"]
        elif rc == "QP constante (CQP)":
            cmd += ["-rc", "constqp", "-qp", str(int(num(c["qp"], 22)))]
        else:
            if rc == "Tamaño objetivo (MB)":
                abr = num(c["abitrate"], 192) if acodec and acodec not in ("copy", "flac") and not acodec.startswith("pcm") else 0
                kbps = num(c["target_mb"], 2000) * 8 * 1024 / max(out_dur, 1) - abr
                if kbps < 100:
                    raise ValueError("El tamaño objetivo es demasiado chico para esta duración.")
                br, mx, mode = kbps, kbps * 1.5, "vbr"
            else:
                br = num(c["bitrate"], 8000)
                mx = num(c["maxrate"]) or (br if rc.endswith("(CBR)") else br * 1.5)
                mode = "cbr" if rc.endswith("(CBR)") else "vbr"
            cmd += ["-rc", mode, "-b:v", f"{int(br)}k", "-maxrate", f"{int(mx)}k", "-bufsize", f"{int(mx * 2)}k"]
        if MULTIPASS[c["multipass"]] != "disabled" and tune not in ("ll", "ull", "lossless"):
            cmd += ["-multipass", MULTIPASS[c["multipass"]]]
        if c["spatial_aq"] and not lossless:  # AQ no es compatible con sin pérdida
            cmd += ["-spatial-aq", "1", "-aq-strength", str(int(num(c["aq_strength"], 8)))]
        if c["temporal_aq"] and not lossless:
            cmd += ["-temporal-aq", "1"]
        bf = int(num(c["bframes"], 3))
        if tune != "uhq":  # uhq fija sus propios B-frames; forzarlos hace fallar al encoder
            cmd += ["-bf", str(bf)]
            if bf >= 2:
                cmd += ["-b_ref_mode", "middle"]
        if int(num(c["lookahead"], 0)) > 0:
            cmd += ["-rc-lookahead", str(int(num(c["lookahead"])))]
        fps_val = c["out_fps"] if c["out_fps"] != "Original" else c.get("_src_fps", "30")
        gop = max(1, round(num(c["gop_sec"], 2) * num(fps_val, 30)))
        cmd += ["-g", str(gop)]
        col = COLORS[c["color"]]
        if col:
            trc = "bt709" if col == "bt709" else "smpte170m"
            cmd += ["-color_primaries", "bt709" if col == "bt709" else "smpte170m",
                    "-color_trc", trc, "-colorspace", col]
        cmd += ["-color_range", RANGES[c["range"]]]

    # Audio
    if not acodec:
        cmd += ["-an"]
    elif acodec == "copy":
        cmd += ["-c:a", "copy"]
    else:
        cmd += ["-c:a", acodec]
        if acodec in ("aac", "libmp3lame", "libopus", "ac3"):
            br = int(num(c["abitrate"], 192))
            if acodec == "libmp3lame":
                br = min(br, 320)
            cmd += ["-b:a", f"{br}k"]
        rate = c["arate"]
        if acodec == "libopus":
            rate = "48000"
        if rate != "Original":
            cmd += ["-ar", rate]
        ch = ACHANNELS[c["achannels"]]
        if ch:
            cmd += ["-ac", str(ch)]
        af = []
        if num(c["volume_db"]) != 0:
            af.append(f"volume={num(c['volume_db'])}dB")
        if c["loudnorm"]:
            af.append(f"loudnorm=I={num(c['lufs'], -14)}:TP=-1.5:LRA=11")
        if af:
            cmd += ["-af", ",".join(af)]

    if c["title"].strip():
        cmd += ["-metadata", f"title={c['title'].strip()}"]
    if ext in ("mp4", "mov") and c["faststart"]:
        cmd += ["-movflags", "+faststart"]
    if ext == "mp4" and acodec in ("pcm_s16le", "pcm_s24le"):
        raise ValueError("MP4 no admite audio PCM. Usá MOV o MKV, o elegí otro códec de audio.")
    if ext == "webm" and (vcodec not in ("av1_nvenc", "copy") or acodec not in ("libopus", None, "copy")):
        raise ValueError("WEBM solo admite video AV1 y audio Opus.")
    cmd += [output]
    return cmd, out_dur


# ── Trabajo en segundo plano ──────────────────────────────────────────────────
class Cancelled(Exception):
    pass


class Job(threading.Thread):
    def __init__(self, cfg, timelines, files, q):
        super().__init__(daemon=True)
        self.c, self.timelines, self.files, self.q = cfg, timelines, files, q
        self.proc, self.cancelled = None, False

    def log(self, s):
        self.q.put(("log", s))

    def cancel(self):
        self.cancelled = True
        kill_tree(self.proc)

    def run(self):
        try:
            if self.c["src_mode"] == "proyecto":
                self.run_project()
            else:
                self.run_files()
            self.q.put(("done", True, "¡Exportación terminada!"))
        except Cancelled:
            self.q.put(("done", False, "Cancelado. Los segmentos ya renderizados se conservan: "
                                       "al volver a iniciar se retoma donde quedó."))
        except Exception as e:  # noqa: BLE001 - se muestra al usuario
            self.q.put(("done", False, f"Error: {e}"))

    # -- Etapa 1: render con CoAnimator --
    def run_project(self):
        c = self.c
        exe = find_coanimator()
        if not exe:
            raise RuntimeError("No se encontró CoAnimator.exe")
        proj_path = c["project_path"]
        proj_name, _ = load_project(proj_path)
        out_dir = c["out_dir"]
        os.makedirs(out_dir, exist_ok=True)
        tmp = os.path.join(out_dir, f"_coa_temp_{safe_name(proj_name)}")
        os.makedirs(tmp, exist_ok=True)

        single = len(self.timelines) == 1
        r_start = num(c["r_start"], 0) if single else 0
        seg_len = num(c["seg_min"], 10) * 60
        fps = num(c["r_fps"], 30)

        plan = []  # (tl, [(start, end, path)])
        for tl in self.timelines:
            end = tl["duration"]
            if single and num(c["r_end"]) > 0:
                end = min(end, num(c["r_end"]))
            start = r_start
            segs = []
            if seg_len > 0:
                step = round(seg_len * fps) / fps
                s, i = start, 0
                while s < end - 1e-6:
                    e = min(s + step, end)
                    segs.append((s, e, os.path.join(tmp, f"{safe_name(tl['id'])}_{i:03d}.mp4")))
                    s, i = e, i + 1
            else:
                segs.append((start, end, os.path.join(tmp, f"{safe_name(tl['id'])}_000.mp4")))
            plan.append((tl, segs))

        total = sum(e - s for _, segs in plan for s, e, _ in segs)
        sig = f"{c['r_res']}|{c['r_fps']}|{c['r_quality']}|{c['r_engine']}"
        done_sec, t_begin = 0.0, time.time()
        for tl, segs in plan:
            for n, (s, e, path) in enumerate(segs):
                if self.cancelled:
                    raise Cancelled
                marker = path + ".done"
                seg_sig = f"{sig}|{s:.4f}|{e:.4f}"
                if os.path.isfile(path) and os.path.isfile(marker) and open(marker).read() == seg_sig:
                    self.log(f"✔ Ya renderizado, se reutiliza: {tl['name']} [{n + 1}/{len(segs)}]")
                    done_sec += e - s
                    continue
                label = f"Render: {tl['name']}  (segmento {n + 1}/{len(segs)}, {fmt_time(s)}–{fmt_time(e)})"
                self.log(label)
                cmd = [exe, "--cli", "render", proj_path, "--timeline", tl["id"],
                       "--resolution", c["r_res"], "--fps", c["r_fps"], "--quality", c["r_quality"],
                       "--engine", c["r_engine"], "--workers", c["r_workers"], "--start", f"{s:.4f}",
                       "--end", f"{e:.4f}", "--out", path]
                if c["r_workers"] == "auto":
                    cmd += ["--mode", c["r_mode"]]
                env = {k: v for k, v in os.environ.items() if k not in ("ELECTRON_RUN_AS_NODE",)}
                self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                                             text=True, encoding="utf-8", errors="replace",
                                             creationflags=NO_WINDOW)
                tail = []
                for line in self.proc.stdout:
                    line = line.rstrip()
                    tail = (tail + [line])[-25:]
                    m = re.search(r"\[cli\] (capturing|encoding) (\d+)%", line)
                    if m:
                        frac = int(m.group(2)) / 100 * (0.92 if m.group(1) == "capturing" else 1)
                        if m.group(1) == "encoding":
                            frac = 0.92 + 0.08 * int(m.group(2)) / 100
                        cur = done_sec + (e - s) * frac
                        el = time.time() - t_begin
                        eta = el / cur * (total - cur) if cur > 1 else 0
                        self.q.put(("p1", cur / total * 100,
                                    f"{label}\n{cur / total * 100:.1f}%  ·  transcurrido {fmt_time(el)}  ·  "
                                    f"restante ≈ {fmt_time(eta)}"))
                    elif line.startswith("[cli]") and "%" not in line:
                        self.log("   " + line)
                self.proc.wait()
                if self.cancelled:
                    raise Cancelled
                if self.proc.returncode != 0:
                    self.log("\n".join(tail))
                    if any("limited to 720p" in ln for ln in tail):
                        raise RuntimeError("Tu CoAnimator es plan Free: el render solo puede ser 720p. Poné "
                                           "'Resolución de render' en 720p y dejá 'Resolución de salida' en "
                                           "1920x1080 (se escala con la GPU), o activá Pro para 1080p nativo.")
                    raise RuntimeError(f"CoAnimator falló en {tl['name']} (código {self.proc.returncode}). "
                                       "Revisá el registro. Volvé a iniciar para reintentar desde este segmento.")
                with open(marker, "w") as f:
                    f.write(seg_sig)
                done_sec += e - s
        self.q.put(("p1", 100, f"Render terminado ({fmt_time(time.time() - t_begin)})"))

        # -- Etapa 2: unión + codificación GPU --
        ext = CONTAINERS[c["container"]]
        base = c["out_name"].strip() or proj_name
        c["_src_fps"] = c["r_fps"]
        if c["join_mode"] == "uno" or single:
            all_segs = [p for _, segs in plan for _, _, p in segs]
            name = base if not single or c["out_name"].strip() else f"{proj_name} - {self.timelines[0]['name']}"
            chapters = None
            if c["chapters"] and len(plan) > 1 and ext in ("mp4", "mkv", "mov"):
                chapters = os.path.join(tmp, "capitulos.txt")
                pos, lines = 0, [";FFMETADATA1"]
                for tl, segs in plan:
                    d = sum(probe_duration(p) for _, _, p in segs)
                    title = tl["name"].replace("=", "\\=").replace(";", "\\;").replace("#", "\\#")
                    lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(pos * 1000)}",
                              f"END={int((pos + d) * 1000)}", f"title={title}"]
                    pos += d
                with open(chapters, "w", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
            self.encode(all_segs, os.path.join(out_dir, f"{safe_name(name)}.{ext}"), tmp, chapters, 1, 1)
        else:
            for i, (tl, segs) in enumerate(plan):
                out = os.path.join(out_dir, f"{safe_name(base)} - {safe_name(tl['name'])}.{ext}")
                self.encode([p for _, _, p in segs], out, tmp, None, i + 1, len(plan))
        if not c["keep_temp"]:
            shutil.rmtree(tmp, ignore_errors=True)
            self.log("Archivos temporales borrados.")

    def run_files(self):
        c = self.c
        os.makedirs(c["out_dir"], exist_ok=True)
        ext = CONTAINERS[c["container"]]
        for i, f in enumerate(self.files):
            name = os.path.splitext(os.path.basename(f))[0]
            if c["out_name"].strip():
                name = c["out_name"].strip() + (f" ({i + 1})" if len(self.files) > 1 else "")
            out = os.path.join(c["out_dir"], f"{safe_name(name)}.{ext}")
            if os.path.abspath(out) == os.path.abspath(f):
                out = os.path.join(c["out_dir"], f"{safe_name(name)} (GPU).{ext}")
            try:
                r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                                    "stream=r_frame_rate", "-of", "default=nw=1:nk=1", f],
                                   capture_output=True, text=True, creationflags=NO_WINDOW).stdout.strip()
                a, b = r.split("/")
                c["_src_fps"] = str(float(a) / float(b))
            except (ValueError, OSError):
                c["_src_fps"] = "30"
            self.encode([f], out, None, None, i + 1, len(self.files))

    def encode(self, sources, output, tmp, chapters, idx, count):
        if len(sources) == 1:
            inp, concat = sources[0], False
            duration = probe_duration(inp)
        else:
            inp = os.path.join(tmp or os.path.dirname(output), "lista_concat.txt")
            with open(inp, "w", encoding="utf-8") as f:
                for s in sources:
                    f.write("file '" + s.replace("\\", "/").replace("'", "'\\''") + "'\n")
            concat = True
            duration = sum(probe_duration(s) for s in sources)
        cmd, out_dur = build_ffmpeg_cmd(self.c, inp, output, duration, chapters, concat)
        self.log(f"\nCodificando con GPU → {output}\n" + " ".join(f'"{a}"' if " " in a else a for a in cmd))
        t0 = time.time()
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
        err_tail = []

        def read_err():
            for line in self.proc.stderr:
                err_tail.append(line.rstrip())
                del err_tail[:-30]
        threading.Thread(target=read_err, daemon=True).start()
        speed, fps_now = "", ""
        for line in self.proc.stdout:
            k, _, v = line.strip().partition("=")
            if k == "speed":
                speed = v
            elif k == "fps":
                fps_now = v
            elif k == "out_time_us" and v.isdigit():
                cur = int(v) / 1e6
                pct = min(100.0, cur / max(out_dur, 0.01) * 100)
                el = time.time() - t0
                eta = el / pct * (100 - pct) if pct > 0.5 else 0
                self.q.put(("p2", pct, f"Codificación GPU {idx}/{count}: {os.path.basename(output)}\n"
                                       f"{pct:.1f}%  ·  {fps_now} fps  ·  velocidad {speed}  ·  "
                                       f"restante ≈ {fmt_time(eta)}"))
        self.proc.wait()
        if self.cancelled:
            raise Cancelled
        if self.proc.returncode != 0:
            time.sleep(0.2)
            self.log("\n".join(err_tail))
            raise RuntimeError("FFmpeg falló al codificar (ver registro).")
        size = os.path.getsize(output) / 1024 ** 2
        self.log(f"✔ Listo: {output}  ({size:,.1f} MB en {fmt_time(time.time() - t0)})")
        self.q.put(("p2", 100, f"Listo: {os.path.basename(output)}"))


# ── Interfaz ──────────────────────────────────────────────────────────────────
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("980x860")
        self.minsize(860, 700)
        self.q = queue.Queue()
        self.job = None
        self.files = []
        self.timelines = []
        self.v = {}
        cfg = dict(DEFAULTS)
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg.update({k: v for k, v in json.load(f).items() if k in DEFAULTS})
        except (OSError, ValueError):
            pass
        for k, val in cfg.items():
            self.v[k] = tk.BooleanVar(value=val) if isinstance(DEFAULTS[k], bool) else tk.StringVar(value=str(val))

        style = ttk.Style(self)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Big.TButton", font=("Segoe UI", 11, "bold"), padding=8)
        style.configure("Head.TLabel", font=("Segoe UI", 10, "bold"))
        self.build()
        self.after(100, self.poll)
        threading.Thread(target=self.check_gpu, daemon=True).start()
        self.on_src_mode()
        if self.v["project_path"].get():
            self.load_timelines()

    # helpers de layout
    def row(self, parent, r, label, widget_fn, **kw):
        ttk.Label(parent, text=label).grid(row=r, column=0, sticky="w", padx=(8, 6), pady=3)
        w = widget_fn(parent, **kw)
        w.grid(row=r, column=1, sticky="we", padx=(0, 8), pady=3)
        return w

    def combo(self, parent, key, values, width=34):
        return ttk.Combobox(parent, textvariable=self.v[key], values=list(values), state="readonly", width=width)

    def entry(self, parent, key, width=12):
        return ttk.Entry(parent, textvariable=self.v[key], width=width)

    def check(self, parent, key, text):
        return ttk.Checkbutton(parent, text=text, variable=self.v[key])

    def build(self):
        top = ttk.Frame(self)
        top.pack(fill="x", padx=10, pady=(8, 2))
        ttk.Label(top, text=APP_TITLE, font=("Segoe UI", 14, "bold")).pack(side="left")
        self.gpu_lbl = ttk.Label(top, text="Detectando GPU…", foreground="#666")
        self.gpu_lbl.pack(side="left", padx=14)
        pf = ttk.Frame(top)
        pf.pack(side="right")
        ttk.Label(pf, text="Preset:").pack(side="left")
        self.preset_var = tk.StringVar(value="(elegir)")
        cb = ttk.Combobox(pf, textvariable=self.preset_var, values=list(EXPORT_PRESETS), state="readonly", width=40)
        cb.pack(side="left", padx=4)
        cb.bind("<<ComboboxSelected>>", self.apply_preset)

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=10, pady=6)
        self.tab_src(nb)
        self.tab_video(nb)
        self.tab_audio(nb)
        self.tab_out(nb)

        bottom = ttk.Frame(self)
        bottom.pack(fill="x", padx=10)
        self.p1_lbl = ttk.Label(bottom, text="Etapa 1 · Render CoAnimator", justify="left")
        self.p1_lbl.pack(anchor="w")
        self.p1 = ttk.Progressbar(bottom, maximum=100)
        self.p1.pack(fill="x", pady=(0, 6))
        self.p2_lbl = ttk.Label(bottom, text="Etapa 2 · Codificación GPU (NVENC)", justify="left")
        self.p2_lbl.pack(anchor="w")
        self.p2 = ttk.Progressbar(bottom, maximum=100)
        self.p2.pack(fill="x")

        btns = ttk.Frame(self)
        btns.pack(fill="x", padx=10, pady=6)
        self.start_btn = ttk.Button(btns, text="▶  Iniciar exportación", style="Big.TButton", command=self.start)
        self.start_btn.pack(side="right")
        self.cancel_btn = ttk.Button(btns, text="Cancelar", command=self.cancel, state="disabled")
        self.cancel_btn.pack(side="right", padx=6)
        ttk.Button(btns, text="Ver comando FFmpeg", command=self.show_cmd).pack(side="left")
        ttk.Button(btns, text="Abrir carpeta de salida", command=lambda: os.startfile(self.v["out_dir"].get())
                   if os.path.isdir(self.v["out_dir"].get()) else None).pack(side="left", padx=6)
        ttk.Button(btns, text="Restablecer opciones", command=self.reset).pack(side="left")

        lf = ttk.LabelFrame(self, text="Registro")
        lf.pack(fill="both", expand=False, padx=10, pady=(0, 10))
        self.logbox = tk.Text(lf, height=8, wrap="word", font=("Consolas", 9), state="disabled")
        sb = ttk.Scrollbar(lf, command=self.logbox.yview)
        self.logbox.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.logbox.pack(fill="both", expand=True)

    def tab_src(self, nb):
        t = ttk.Frame(nb)
        nb.add(t, text="  1 · Origen  ")
        mf = ttk.Frame(t)
        mf.pack(fill="x", padx=8, pady=6)
        ttk.Radiobutton(mf, text="Proyecto de CoAnimator (render + codificación GPU)", value="proyecto",
                        variable=self.v["src_mode"], command=self.on_src_mode).pack(side="left")
        ttk.Radiobutton(mf, text="Video(s) ya exportado(s) (solo recodificar con GPU)", value="archivos",
                        variable=self.v["src_mode"], command=self.on_src_mode).pack(side="left", padx=16)

        # Proyecto
        self.proj_frame = pf = ttk.Frame(t)
        r1 = ttk.Frame(pf)
        r1.pack(fill="x", padx=8)
        ttk.Label(r1, text="Proyecto:").pack(side="left")
        projs = []
        if os.path.isdir(projects_dir()):
            projs = [os.path.join(projects_dir(), d) for d in sorted(os.listdir(projects_dir()))
                     if os.path.isfile(os.path.join(projects_dir(), d, "project.json"))]
        self.proj_cb = ttk.Combobox(r1, textvariable=self.v["project_path"], values=projs, width=70)
        self.proj_cb.pack(side="left", padx=4, fill="x", expand=True)
        if not self.v["project_path"].get() and projs:
            self.v["project_path"].set(projs[0])
        self.proj_cb.bind("<<ComboboxSelected>>", lambda e: self.load_timelines())
        self.proj_cb.bind("<Return>", lambda e: self.load_timelines())
        ttk.Button(r1, text="Buscar carpeta…", command=self.browse_project).pack(side="left")

        tf = ttk.Frame(pf)
        tf.pack(fill="both", expand=True, padx=8, pady=6)
        self.tree = ttk.Treeview(tf, columns=("dur",), height=9, selectmode="extended")
        self.tree.heading("#0", text="Timeline (Ctrl/Shift + clic para elegir varios)")
        self.tree.heading("dur", text="Duración")
        self.tree.column("#0", width=560)
        self.tree.column("dur", width=90, anchor="e")
        sb = ttk.Scrollbar(tf, command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="left", fill="y")
        self.tree.bind("<<TreeviewSelect>>", lambda e: self.update_sel_info())
        side = ttk.Frame(tf)
        side.pack(side="left", fill="y", padx=8)
        ttk.Button(side, text="Seleccionar todos", command=lambda: self.tree.selection_set(self.tree.get_children())).pack(fill="x")
        ttk.Button(side, text="Ninguno", command=lambda: self.tree.selection_set(())).pack(fill="x", pady=4)
        self.sel_info = ttk.Label(side, text="", wraplength=180, justify="left")
        self.sel_info.pack(fill="x", pady=8)

        g = ttk.LabelFrame(pf, text="Render de CoAnimator (etapa 1)")
        g.pack(fill="x", padx=8, pady=4)
        g.columnconfigure(1, weight=1)
        g.columnconfigure(3, weight=1)

        def pair(r, col, label, w):
            ttk.Label(g, text=label).grid(row=r, column=col, sticky="w", padx=(8, 6), pady=3)
            w.grid(row=r, column=col + 1, sticky="w", padx=(0, 8), pady=3)
        pair(0, 0, "Resolución de render:", self.combo(g, "r_res", RENDER_RES, 10))
        pair(0, 2, "FPS de render:", ttk.Combobox(g, textvariable=self.v["r_fps"], width=10,
                                                  values=["24", "25", "30", "50", "60"]))
        pair(1, 0, "Calidad intermedia:", self.combo(g, "r_quality", RENDER_QUALITY, 10))
        pair(1, 2, "Motor:", self.combo(g, "r_engine", RENDER_ENGINES, 16))
        pair(2, 0, "Workers en paralelo:", self.combo(g, "r_workers", RENDER_WORKERS, 10))
        pair(2, 2, "Modo (si workers = auto):", self.combo(g, "r_mode", RENDER_MODES, 16))
        pair(3, 0, "Dividir en segmentos de (min):", self.entry(g, "seg_min", 8))
        pair(3, 2, "Tramo (solo 1 timeline) desde/hasta s:", self._range_widget(g))
        ttk.Label(g, foreground="#555", wraplength=860, justify="left", text=(
            "Los segmentos permiten retomar si algo falla o cancelás (0 = sin dividir). "
            "Más workers = más rápido pero más RAM: con 32 GB probá 8–12. "
            "Calidad intermedia 'max' evita perder calidad antes de la codificación final. "
            "Con CoAnimator Free el render está limitado a 720p (1080p/4K requieren Pro).")).grid(
            row=4, column=0, columnspan=4, sticky="w", padx=8, pady=(2, 6))

        j = ttk.LabelFrame(pf, text="Si elegís varios timelines")
        j.pack(fill="x", padx=8, pady=4)
        ttk.Radiobutton(j, text="Unir todo en un solo video", value="uno", variable=self.v["join_mode"]).pack(side="left", padx=8, pady=4)
        ttk.Radiobutton(j, text="Un video por timeline", value="separados", variable=self.v["join_mode"]).pack(side="left", padx=8)
        self.check(j, "chapters", "Agregar capítulos con el nombre de cada timeline (MP4/MKV/MOV)").pack(side="left", padx=16)

        # Archivos
        self.files_frame = ff = ttk.Frame(t)
        bf = ttk.Frame(ff)
        bf.pack(fill="x", padx=8)
        ttk.Button(bf, text="Agregar videos…", command=self.add_files).pack(side="left")
        ttk.Button(bf, text="Quitar seleccionados", command=self.remove_files).pack(side="left", padx=6)
        self.files_lb = tk.Listbox(ff, selectmode="extended", height=14)
        self.files_lb.pack(fill="both", expand=True, padx=8, pady=6)

    def _range_widget(self, parent):
        f = ttk.Frame(parent)
        ttk.Entry(f, textvariable=self.v["r_start"], width=8).pack(side="left")
        ttk.Label(f, text=" a ").pack(side="left")
        ttk.Entry(f, textvariable=self.v["r_end"], width=8).pack(side="left")
        return f

    def tab_video(self, nb):
        t = ttk.Frame(nb)
        nb.add(t, text="  2 · Video  ")
        t.columnconfigure(0, weight=1)
        t.columnconfigure(1, weight=1)
        a = ttk.LabelFrame(t, text="Códec y calidad")
        a.grid(row=0, column=0, sticky="nsew", padx=8, pady=6)
        a.columnconfigure(1, weight=1)
        self.row(a, 0, "Códec:", self.combo, key="vcodec", values=VCODECS)
        self.row(a, 1, "Preset NVENC:", self.combo, key="preset", values=PRESETS_NV)
        self.row(a, 2, "Ajuste (tune):", self.combo, key="tune", values=TUNES)
        self.row(a, 3, "Control de tasa:", self.combo, key="rc", values=RATECTRL)
        self.row(a, 4, "Nivel CQ (0–51, menor = mejor):", self.entry, key="cq")
        self.row(a, 5, "QP (modo CQP):", self.entry, key="qp")
        self.row(a, 6, "Bitrate (kbps):", self.entry, key="bitrate")
        self.row(a, 7, "Bitrate máximo (kbps, opcional):", self.entry, key="maxrate")
        self.row(a, 8, "Tamaño objetivo (MB):", self.entry, key="target_mb")
        self.row(a, 9, "Multipasada:", self.combo, key="multipass", values=MULTIPASS)
        self.row(a, 10, "Formato de color:", self.combo, key="pixfmt", values=PIXFMTS)

        b = ttk.LabelFrame(t, text="Imagen")
        b.grid(row=0, column=1, sticky="nsew", padx=8, pady=6)
        b.columnconfigure(1, weight=1)
        self.row(b, 0, "Resolución de salida:", self.combo, key="out_res", values=RESOLUTIONS)
        cf = ttk.Frame(b)
        ttk.Entry(cf, textvariable=self.v["custom_w"], width=7).pack(side="left")
        ttk.Label(cf, text=" x ").pack(side="left")
        ttk.Entry(cf, textvariable=self.v["custom_h"], width=7).pack(side="left")
        ttk.Label(b, text="Personalizada (ancho x alto):").grid(row=1, column=0, sticky="w", padx=(8, 6))
        cf.grid(row=1, column=1, sticky="w")
        self.row(b, 2, "Si cambia la proporción:", self.combo, key="fit", values=FITS)
        self.row(b, 3, "Algoritmo de escalado:", self.combo, key="scaler", values=SCALERS)
        self.row(b, 4, "FPS de salida:", self.combo, key="out_fps", values=FPS_OUT)
        self.row(b, 5, "Espacio de color:", self.combo, key="color", values=COLORS)
        self.row(b, 6, "Rango:", self.combo, key="range", values=RANGES)
        self.row(b, 7, "Nitidez (al escalar):", self.combo, key="sharpen", values=SHARPEN)

        c = ttk.LabelFrame(t, text="Avanzado")
        c.grid(row=1, column=0, columnspan=2, sticky="nsew", padx=8, pady=6)
        for i in (1, 3):
            c.columnconfigure(i, weight=1)
        items = [("B-frames (0–4):", "bframes"), ("Keyframe cada (s):", "gop_sec"),
                 ("Lookahead (fotogramas):", "lookahead"), ("Fuerza AQ (1–15):", "aq_strength")]
        for i, (lbl, key) in enumerate(items):
            ttk.Label(c, text=lbl).grid(row=i // 2, column=(i % 2) * 2, sticky="w", padx=(8, 6), pady=3)
            self.entry(c, key, 8).grid(row=i // 2, column=(i % 2) * 2 + 1, sticky="w", pady=3)
        self.check(c, "spatial_aq", "AQ espacial (mejor en zonas planas)").grid(row=2, column=0, columnspan=2, sticky="w", padx=8)
        self.check(c, "temporal_aq", "AQ temporal").grid(row=2, column=2, sticky="w", padx=8)
        self.check(c, "gpu_decode", "Decodificar con GPU (NVDEC)").grid(row=2, column=3, sticky="w", padx=8)

    def tab_audio(self, nb):
        t = ttk.Frame(nb)
        nb.add(t, text="  3 · Audio  ")
        a = ttk.LabelFrame(t, text="Audio")
        a.pack(fill="x", padx=8, pady=6)
        a.columnconfigure(1, weight=1)
        self.row(a, 0, "Códec:", self.combo, key="acodec", values=ACODECS)
        self.row(a, 1, "Bitrate (kbps):", self.combo, key="abitrate", values=ABITRATES)
        self.row(a, 2, "Frecuencia de muestreo (Hz):", self.combo, key="arate", values=ARATES)
        self.row(a, 3, "Canales:", self.combo, key="achannels", values=ACHANNELS)
        self.row(a, 4, "Ganancia (dB):", self.entry, key="volume_db")
        self.check(a, "loudnorm", "Normalizar volumen (EBU R128)").grid(row=5, column=0, sticky="w", padx=8, pady=3)
        lf = ttk.Frame(a)
        ttk.Label(lf, text="Objetivo LUFS:").pack(side="left")
        ttk.Entry(lf, textvariable=self.v["lufs"], width=6).pack(side="left", padx=4)
        ttk.Label(lf, text="(YouTube/Spotify −14, TV −23, podcast −16)", foreground="#666").pack(side="left")
        lf.grid(row=5, column=1, sticky="w")

    def tab_out(self, nb):
        t = ttk.Frame(nb)
        nb.add(t, text="  4 · Salida  ")
        a = ttk.LabelFrame(t, text="Archivo de salida")
        a.pack(fill="x", padx=8, pady=6)
        a.columnconfigure(1, weight=1)
        self.row(a, 0, "Contenedor:", self.combo, key="container", values=CONTAINERS)
        df = ttk.Frame(a)
        ttk.Entry(df, textvariable=self.v["out_dir"]).pack(side="left", fill="x", expand=True)
        ttk.Button(df, text="Elegir…", command=self.browse_out).pack(side="left", padx=4)
        ttk.Label(a, text="Carpeta:").grid(row=1, column=0, sticky="w", padx=(8, 6))
        df.grid(row=1, column=1, sticky="we", padx=(0, 8), pady=3)
        self.row(a, 2, "Nombre (vacío = automático):", self.entry, key="out_name", width=40)
        self.row(a, 3, "Título (metadatos):", self.entry, key="title", width=40)
        self.check(a, "faststart", "Optimizar para web / reproducción inmediata (faststart)").grid(row=4, column=0, columnspan=2, sticky="w", padx=8)
        self.check(a, "keep_temp", "Conservar segmentos temporales al terminar").grid(row=5, column=0, columnspan=2, sticky="w", padx=8)
        b = ttk.LabelFrame(t, text="Recortar la salida (segundos, vacío = completo)")
        b.pack(fill="x", padx=8, pady=6)
        ttk.Label(b, text="Desde:").pack(side="left", padx=8, pady=4)
        self.entry(b, "trim_start", 10).pack(side="left")
        ttk.Label(b, text="Hasta:").pack(side="left", padx=8)
        self.entry(b, "trim_end", 10).pack(side="left")

    # ── acciones ──
    def check_gpu(self):
        try:
            name = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                                  text=True, creationflags=NO_WINDOW, timeout=10).stdout.strip().splitlines()[0]
        except (OSError, IndexError, subprocess.TimeoutExpired):
            name = "GPU NVIDIA no detectada"
        ok = []
        for enc in ("h264_nvenc", "hevc_nvenc", "av1_nvenc"):
            try:
                r = subprocess.run([FFMPEG, "-hide_banner", "-v", "error", "-f", "lavfi", "-i",
                                    "color=black:s=640x360:d=0.2", "-c:v", enc, "-f", "null", "-"],
                                   capture_output=True, creationflags=NO_WINDOW, timeout=20)
                if r.returncode == 0:
                    ok.append(enc.split("_")[0].upper())
            except (OSError, subprocess.TimeoutExpired):
                pass
        txt = f"{name}  ·  NVENC: {', '.join(ok) if ok else 'NO DISPONIBLE'}"
        if not find_coanimator():
            txt += "  ·  ⚠ CoAnimator no encontrado"
        self.q.put(("gpu", txt, bool(ok)))

    def on_src_mode(self):
        if self.v["src_mode"].get() == "proyecto":
            self.files_frame.pack_forget()
            self.proj_frame.pack(fill="both", expand=True)
        else:
            self.proj_frame.pack_forget()
            self.files_frame.pack(fill="both", expand=True)

    def browse_project(self):
        d = filedialog.askdirectory(initialdir=projects_dir(), title="Carpeta del proyecto (contiene project.json)")
        if d:
            self.v["project_path"].set(os.path.normpath(d))
            self.load_timelines()

    def load_timelines(self):
        p = self.v["project_path"].get()
        self.tree.delete(*self.tree.get_children())
        try:
            name, self.timelines = load_project(p)
        except (OSError, ValueError) as e:
            self.timelines = []
            self.log(f"No se pudo leer el proyecto: {e}")
            return
        for i, tl in enumerate(self.timelines):
            self.tree.insert("", "end", iid=str(i), text=tl["name"], values=(fmt_time(tl["duration"]),))
        self.tree.selection_set(self.tree.get_children())
        self.log(f"Proyecto «{name}»: {len(self.timelines)} timelines, "
                 f"{fmt_time(sum(t['duration'] for t in self.timelines))} en total.")

    def update_sel_info(self):
        sel = [self.timelines[int(i)] for i in self.tree.selection()]
        self.sel_info.config(text=f"{len(sel)} seleccionados\nDuración: {fmt_time(sum(t['duration'] for t in sel))}")

    def add_files(self):
        fs = filedialog.askopenfilenames(title="Videos", filetypes=[("Video", "*.mp4 *.mov *.mkv *.webm *.avi *.m4v"), ("Todos", "*.*")])
        for f in fs:
            self.files.append(f)
            self.files_lb.insert("end", f)

    def remove_files(self):
        for i in reversed(self.files_lb.curselection()):
            self.files_lb.delete(i)
            del self.files[i]

    def browse_out(self):
        d = filedialog.askdirectory(initialdir=self.v["out_dir"].get())
        if d:
            self.v["out_dir"].set(os.path.normpath(d))

    def apply_preset(self, _=None):
        for k, val in EXPORT_PRESETS[self.preset_var.get()].items():
            self.v[k].set(val)
        self.log(f"Preset aplicado: {self.preset_var.get()}")

    def reset(self):
        for k, val in DEFAULTS.items():
            if k not in ("project_path", "out_dir"):
                self.v[k].set(val)

    def cfg(self):
        return {k: var.get() for k, var in self.v.items()}

    def save_cfg(self):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self.cfg(), f, ensure_ascii=False, indent=1)
        except OSError:
            pass

    def show_cmd(self):
        c = self.cfg()
        c["_src_fps"] = c["r_fps"]
        try:
            cmd, _ = build_ffmpeg_cmd(c, "ENTRADA.mp4", f"SALIDA.{CONTAINERS[c['container']]}", 3600)
        except ValueError as e:
            messagebox.showerror(APP_TITLE, str(e))
            return
        w = tk.Toplevel(self)
        w.title("Comando FFmpeg (etapa 2)")
        txt = tk.Text(w, width=110, height=10, wrap="word", font=("Consolas", 9))
        txt.insert("1.0", " ".join(f'"{a}"' if " " in a else a for a in cmd))
        txt.pack(fill="both", expand=True, padx=8, pady=8)

    def start(self):
        c = self.cfg()
        tls, files = [], list(self.files)
        if c["src_mode"] == "proyecto":
            if not find_coanimator():
                messagebox.showerror(APP_TITLE, "No se encontró CoAnimator.exe instalado.")
                return
            tls = [self.timelines[int(i)] for i in sorted(self.tree.selection(), key=int)]
            if not tls:
                messagebox.showwarning(APP_TITLE, "Elegí al menos un timeline.")
                return
        elif not files:
            messagebox.showwarning(APP_TITLE, "Agregá al menos un video.")
            return
        try:  # valida opciones antes de empezar
            c2 = dict(c, _src_fps=c["r_fps"])
            build_ffmpeg_cmd(c2, "x.mp4", "y." + CONTAINERS[c["container"]], 3600)
        except ValueError as e:
            messagebox.showerror(APP_TITLE, str(e))
            return
        self.save_cfg()
        self.p1["value"] = self.p2["value"] = 0
        self.start_btn.config(state="disabled")
        self.cancel_btn.config(state="normal")
        self.log("─" * 60 + f"\nInicio: {time.strftime('%H:%M:%S')}")
        self.job = Job(c, tls, files, self.q)
        self.job.start()

    def cancel(self):
        if self.job:
            self.cancel_btn.config(state="disabled")
            self.log("Cancelando…")
            threading.Thread(target=self.job.cancel, daemon=True).start()

    def log(self, s):
        self.logbox.config(state="normal")
        self.logbox.insert("end", s + "\n")
        self.logbox.see("end")
        self.logbox.config(state="disabled")

    def poll(self):
        try:
            while True:
                m = self.q.get_nowait()
                if m[0] == "log":
                    self.log(m[1])
                elif m[0] == "p1":
                    self.p1["value"], _ = m[1], self.p1_lbl.config(text="Etapa 1 · " + m[2])
                elif m[0] == "p2":
                    self.p2["value"], _ = m[1], self.p2_lbl.config(text="Etapa 2 · " + m[2])
                elif m[0] == "gpu":
                    self.gpu_lbl.config(text=m[1], foreground="#0a7d2c" if m[2] else "#b00020")
                elif m[0] == "done":
                    self.start_btn.config(state="normal")
                    self.cancel_btn.config(state="disabled")
                    self.log(m[2])
                    self.job = None
                    (messagebox.showinfo if m[1] else messagebox.showwarning)(APP_TITLE, m[2])
        except queue.Empty:
            pass
        self.after(100, self.poll)

    def destroy(self):
        self.save_cfg()
        if self.job:
            self.job.cancel()
        super().destroy()


if __name__ == "__main__":
    App().mainloop()
