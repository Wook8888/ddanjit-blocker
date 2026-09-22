"""웹스토어에 올릴 zip 을 만든다.

extension/manifest.json 에는 개발용 "key" 가 들어 있다.
(폴더에서 설치해도 스토어와 같은 ID pfkbjkdjdpbkhekieeadeklafnndhlcd 가 되게 해서,
 여러 기기에서 시험할 때 크롬 동기화가 서로 맞도록 하기 위함)
스토어는 업로드 파일의 "key" 를 받지 않으므로, zip 에서는 빼고 담는다.

사용:  python make-store-zip.py      →  ddanjit-blocker-v<버전>.zip
"""
import json, pathlib, zipfile

root = pathlib.Path(__file__).resolve().parent
ext = root / "extension"
manifest = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
manifest.pop("key", None)
out = root / f"ddanjit-blocker-v{manifest['version']}.zip"

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(ext.rglob("*")):
        if f.is_dir() or f.name == ".DS_Store":
            continue
        rel = f.relative_to(ext).as_posix()
        if rel == "manifest.json":
            z.writestr(rel, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        else:
            z.write(f, rel)
print(out.name)
