"""Install the Codingbox bootstrap in this preview Box's Node entrypoint."""
import pathlib
import stat

entrypoint = pathlib.Path('/usr/local/bin/docker-entrypoint.sh')
state = pathlib.Path('/opt/codingbox/.data')
source = entrypoint.read_text()
marker = '# Codingbox on-demand bootstrap'
if marker in source:
    print('Codingbox boot hook already installed')
else:
    if source.count('exec "$@"') != 1 or not state.is_dir():
        raise SystemExit('Expected the Node image entrypoint and an initialized Codingbox directory')
    backup = state / 'docker-entrypoint.original.sh'
    if not backup.exists():
        backup.write_text(source)
        backup.chmod(0o600)
    block = '''
# Codingbox on-demand bootstrap
if [ -f /opt/codingbox/.env ] && [ -f /opt/codingbox/deploy/boxlite-boot.sh ]; then
  /bin/sh /opt/codingbox/deploy/boxlite-boot.sh >> /opt/codingbox/.data/boot.log 2>&1 &
fi
'''
    mode = stat.S_IMODE(entrypoint.stat().st_mode)
    entrypoint.write_text(source.replace('exec "$@"', block + '\nexec "$@"'))
    entrypoint.chmod(mode)
    print('Codingbox boot hook installed')
