"""
Transcripción local con Whisper (Hugging Face transformers) para OpenAnimator.

Uso:  python transcribe.py <audio.f32> <modelo> [idioma|auto] [cuda|cpu|auto]
  <audio.f32>  PCM float32 mono 16 kHz crudo (lo prepara la app con su FFmpeg)
  <modelo>     id de Hugging Face (openai/whisper-large-v3-turbo) o carpeta local

Nunca descarga nada: usa sólo modelos que ya estén en la caché de Hugging Face.
Imprime en la última línea de stdout:  {"text", "lang", "words": [{w, start, end}], "device", "model"}
El progreso va a stderr con el prefijo "@@ ".
"""
import json
import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")


def log(msg):
    print("@@ " + msg, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) < 3:
        print("uso: transcribe.py <audio.f32> <modelo> [idioma] [device]", file=sys.stderr)
        sys.exit(2)
    audio_path, model_id = sys.argv[1], sys.argv[2]
    lang = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] not in ("", "auto") else None
    want = sys.argv[4] if len(sys.argv) > 4 else "auto"

    import warnings
    warnings.filterwarnings("ignore")
    import numpy as np
    import torch
    from transformers import pipeline
    from transformers.utils import logging as hf_logging
    hf_logging.set_verbosity_error()

    cuda = torch.cuda.is_available() and want != "cpu"
    device = "cuda:0" if cuda else "cpu"
    dtype = torch.float16 if cuda else torch.float32

    audio = np.fromfile(audio_path, dtype=np.float32)
    if audio.size == 0:
        print(json.dumps({"text": "", "lang": lang, "words": [], "device": device, "model": model_id}))
        return
    log(f"cargando {model_id} en {'GPU' if cuda else 'CPU'}")
    asr = pipeline("automatic-speech-recognition", model=model_id, device=device, dtype=dtype)

    detected = lang
    if not detected:
        try:
            feats = asr.feature_extractor(audio[: 16000 * 30], sampling_rate=16000, return_tensors="pt").input_features
            ids = asr.model.detect_language(feats.to(device, dtype))
            tok = asr.tokenizer.convert_ids_to_tokens(int(ids.flatten()[0]))
            detected = tok.strip("<|>") if tok else None
        except Exception:
            detected = None

    gen = {"task": "transcribe"}
    if detected:
        gen["language"] = detected
    log(f"transcribiendo {audio.size / 16000:.1f} s")
    out = asr(
        {"raw": audio, "sampling_rate": 16000},
        return_timestamps="word",
        chunk_length_s=30,
        batch_size=8 if cuda else 1,
        generate_kwargs=gen,
    )

    words = []
    for c in out.get("chunks") or []:
        t = (c.get("text") or "").strip()
        s, e = c.get("timestamp") or (None, None)
        if not t or s is None:
            continue
        if e is None or e < s:
            e = s + 0.3
        words.append({"w": t, "start": round(float(s), 3), "end": round(float(e), 3)})
    print(json.dumps({"text": (out.get("text") or "").strip(), "lang": detected, "words": words,
                      "device": "GPU" if cuda else "CPU", "model": model_id}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # el mensaje lo muestra la app
        msg = str(e)
        if "offline" in msg.lower() or "cannot find" in msg.lower() or "not found" in msg.lower():
            msg = "El modelo no está descargado en este equipo (" + msg[:200] + ")"
        print(json.dumps({"error": msg[:600]}, ensure_ascii=False))
        sys.exit(1)
