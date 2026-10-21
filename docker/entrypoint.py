import json
import os
import pathlib
import shutil

home = pathlib.Path('/home/coder')
project = home / 'project'
project.mkdir(exist_ok=True)
marker = home / '.codingbox-initialized'
if not marker.exists():
    language = os.environ.get('CODINGBOX_LANGUAGE', 'python')
    if language not in ('python', 'typescript', 'go', 'cpp', 'rust'):
        raise ValueError('Unsupported language')
    shutil.copytree(f'/opt/codingbox/templates/{language}', project, dirs_exist_ok=True)
    marker.touch()

config = home / 'wede.config.json'
config.write_text(json.dumps({
    'password': os.environ['WEDE_PASSWORD'],
    'host': '0.0.0.0', 'port': '9090', 'workspace_root': str(home),
}))
config.chmod(0o600)
(home / '.bash_profile').write_text('export PATH=/opt/rust/bin:/opt/python/bin:/usr/local/go/bin:/usr/local/bin:$PATH\n')
os.environ.pop('WEDE_PASSWORD', None)
os.execv('/usr/local/bin/wede', ['wede', str(project)])
