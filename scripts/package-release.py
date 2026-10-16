"""Build an allowlisted, reproducible extension ZIP; never package a workspace tree."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]

def write_zip(target, files, prefix=''):
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, file in sorted(files.items()):
            if file.is_symlink() or not file.is_file():
                raise ValueError('Missing or unsafe release file: ' + name)
            info = zipfile.ZipInfo(prefix + name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None:
            raise ValueError('Corrupt ZIP')
        for name, file in files.items():
            if archive.read(prefix + name) != file.read_bytes():
                raise ValueError('ZIP readback mismatch: ' + name)

def main():
    version = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
    if json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version'] != version:
        raise ValueError('Version mismatch')
    build = ROOT / 'outputs' / ('chaoxing-study-helper-' + version)
    names = {p.name for p in (ROOT / 'extension').iterdir() if p.suffix in {'.js', '.html', '.css', '.json'}}
    names.update({'LICENSE', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', '安装使用说明.md', '构建说明.txt', 'vendor/pdf-lib.min.js', 'vendor/pdf-lib-LICENSE.md'})
    names.update('vendor/noble-hashes/' + n for n in ['sha2.js', '_md.js', '_u64.js', 'utils.js', 'LICENSE'])
    names.update('vendor/licenses/' + n + '.txt' for n in ['pdf-lib-standard-fonts', 'pdf-lib-upng', 'pako'])
    names.update('vendor/licenses/tslib-' + n for n in ['LICENSE.txt', 'CopyrightNotice.txt'])
    actual = {p.relative_to(build).as_posix() for p in build.rglob('*') if p.is_file()}
    if actual != names:
        raise ValueError('Build allowlist mismatch: ' + repr(sorted(actual ^ names)))
    if json.loads((build / 'manifest.json').read_text(encoding='utf-8'))['version'] != version:
        raise ValueError('Build version mismatch')
    output = ROOT / 'outputs' / ('release-' + version)
    output.mkdir(parents=True, exist_ok=True)
    extension = output / ('chaoxing-study-helper-' + version + '.zip')
    write_zip(extension, {name: build / name for name in names}, 'chaoxing-study-helper-' + version + '/')
    promo = output / ('chaoxing-study-helper-' + version + '-promo.zip')
    write_zip(promo, {name: ROOT / 'docs' / name for name in ['推广素材.md', '试用反馈.md', 'assets/overview.png', 'assets/settings.png', 'assets/demo.gif']})
    hashes = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in [extension, promo])
    (output / 'SHA256SUMS.txt').write_text(hashes, encoding='utf-8')
    print(json.dumps({'version': version, 'extension_files': len(names), 'output': str(output), 'sha256': hashes.splitlines()}, ensure_ascii=True))

if __name__ == '__main__':
    main()
