"""Lista fija de los archivos de los modelos de Whisper del iPhone (WhisperKit, Core ML): revisión exacta de Hugging Face,
SHA-256 y tamaño de cada archivo (los grandes, de la API; los chicos se bajan y se calculan). La app baja y verifica eso
(ios/OpenAnimator/LocalWhisper.swift). Para cambiar de revisión: editar WKREV/TOK y correr  python scripts/whisperkit-models.py"""
import hashlib, json, urllib.request

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'oa'}), timeout=120) as r:
        return r.read()

def tree(repo, rev, path=''):
    return json.loads(get(f'https://huggingface.co/api/models/{repo}/tree/{rev}/{path}?recursive=true'))

def files(repo, rev, path='', only=None):
    out = []
    for e in tree(repo, rev, path):
        if e['type'] != 'file' or (only and e['path'].split('/')[-1] not in only):
            continue
        if e.get('lfs'):
            sha, size = e['lfs']['oid'], e['lfs']['size']
        else:  # archivo chico: se baja y se calcula
            b = get(f'https://huggingface.co/{repo}/resolve/{rev}/{e["path"]}')
            sha, size = hashlib.sha256(b).hexdigest(), len(b)
        out.append({'url': f'https://huggingface.co/{repo}/resolve/{rev}/{e["path"]}', 'path': e['path'][len(path) + 1:] if path else e['path'], 'size': size, 'sha256': sha})
    return out

WK, WKREV = 'argmaxinc/whisperkit-coreml', '0f63a7800b00dd0226abd051b906c246e1907482'
TOK = {'openai/whisper-large-v3': '06f233fe06e710322aca913c1bc4249a0d71fce1', 'openai/whisper-small': '973afd24965f72e36ca33b3055d56a652f456b4d'}
models = []
for mid, folder, tok, label in [
    ('large-v3-turbo', 'openai_whisper-large-v3-v20240930_626MB', 'openai/whisper-large-v3', 'large-v3-turbo'),
    ('small', 'openai_whisper-small', 'openai/whisper-small', 'small'),
]:
    fl = files(WK, WKREV, folder) + files(tok, TOK[tok], '', {'tokenizer.json', 'tokenizer_config.json'})
    models.append({'id': mid, 'label': label, 'files': fl, 'bytes': sum(f['size'] for f in fl)})
    print(mid, len(fl), 'archivos,', round(sum(f['size'] for f in fl) / 1e6), 'MB')
import os
json.dump({'source': f'{WK}@{WKREV}', 'models': models}, open(os.path.join(os.path.dirname(__file__), '..', 'ios', 'OpenAnimator', 'whisper-models.json'), 'w'), indent=1)
