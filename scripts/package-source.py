"""Create an allowlisted, dependency-free source archive and SHA-256 file manifest."""
from pathlib import Path
import hashlib, json, sys, zipfile
ROOT = Path(__file__).resolve().parent.parent
FILES = [
    'package.json', 'package-lock.json', 'README.md', 'openapi.json', 'Dockerfile',
    '.dockerignore', '.gitignore', '.env.example', 'SOURCE_REFERENCES.md', 'VALIDATION.md', 'ACCEPTANCE_SUMMARY.md',
    'src/config.mjs', 'src/runtime.mjs', 'src/backend.mjs', 'src/server.mjs',
    'runtime/bounded-tools.mjs', 'config/profiles.example.json',
    'skills/document-review/SKILL.md', 'examples/plugins/text-stats.mjs',
    'tests/api.test.mjs', 'tests/security.test.mjs', 'tests/integration/runtime.test.mjs',
    'test-support/model-stub.mjs', 'test-support/README.md',
    'scripts/generate-openapi.py', 'scripts/smoke-runtime.mjs', 'scripts/package-source.py',
]
def main():
    destination = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'dist')
    destination.mkdir(parents=True, exist_ok=True)
    records = []
    for name in FILES:
        data = (ROOT/name).read_bytes()
        records.append({'path':name, 'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest()})
    manifest = {'project':'document-review-harness-backend', 'version':'0.1.0', 'runtime':'@deepseek-ai/dsh@0.2.1-alpha.3', 'files':records, 'excluded':['node_modules','vendor upstream checkout','runtime data/logs','credentials','.git']}
    manifest_data = (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode()
    (destination/'source-manifest.json').write_bytes(manifest_data)
    archive = destination/'document-review-harness-backend-0.1.0.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in FILES: z.write(ROOT/name, 'document-review-harness-backend-0.1.0/'+name)
        z.writestr('document-review-harness-backend-0.1.0/source-manifest.json',manifest_data)
    print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'files':len(FILES),'manifest':str(destination/'source-manifest.json')}))
if __name__ == '__main__': main()
