"""Real sudo regression tests. Only run inside sudo_bridge_integration.sh's chroot."""
import os
import selectors
import subprocess
import time
import uuid


def run(command, passwords, disconnect=False):
    directory = '/tmp/marcel-sudo-' + uuid.uuid4().hex
    control = subprocess.Popen(
        ['sudo', '-u', 'tester', 'sh', '/tmp/bridge.sh', directory],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
    )
    process = None
    try:
        ready = control.stdout.readline()
        assert ready.startswith('READY '), control.stderr.read()
        directory = bytes.fromhex(ready.split()[1]).decode()
        command = command.replace('@bridge@', directory)
        process = subprocess.Popen(
            ['sudo', '-u', 'tester', 'env', 'PATH=' + directory + ':' + os.environ['PATH'],
             'SUDO_ASKPASS=' + directory + '/askpass', 'sh', '-c', command],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        requests = []
        pending = ''
        start = time.monotonic()
        with selectors.DefaultSelector() as selector:
            selector.register(control.stdout, selectors.EVENT_READ)
            while process.poll() is None:
                assert time.monotonic() - start < 20, 'command hung'
                for key, _ in selector.select(.05):
                    data = os.read(key.fileobj.fileno(), 65536)
                    assert data, 'control closed'
                    pending += data.decode()
                    while '\n' in pending:
                        line, pending = pending.split('\n', 1)
                        pid, call, account = line.split()
                        assert bytes.fromhex(account).decode() == 'tester', line
                        requests.append((pid, call))
                        if disconnect:
                            control.stdin.close()
                            control.wait(timeout=3)
                            output, error = process.communicate(timeout=3)
                            assert 'must-not-run' not in output
                            return process.returncode, output, error, requests
                        assert passwords, 'unexpected password request'
                        password = passwords.pop(0)
                        writer = subprocess.Popen(
                            ['sudo', '-u', 'tester', 'sh', '-c', 'cat > "$1"',
                             'reply', directory + '/reply-' + pid], stdin=subprocess.PIPE,
                        )
                        writer.communicate(None if password is None else (password + '\n').encode(), timeout=5)
        output, error = process.communicate(timeout=2)
        assert 'testpw' not in output + error
        return process.returncode, output, error, requests
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        if not control.stdin.closed:
            control.stdin.close()
        control.wait(timeout=3)
        assert not os.path.exists(directory), 'helper directory leaked'


status, output, error, requests = run('sudo /usr/bin/id -u', [])
assert status == 0 and output.strip() == '0' and not requests, (status, output, error)
status, output, error, requests = run("echo before; printf 'payload' | sudo -u root /bin/cat; echo after", ['wrong', 'testpw'])
assert status == 0 and output == 'before\npayloadafter\n', (status, output, error)
assert len(requests) == 2 and requests[0][1] == requests[1][1]
status, output, error, requests = run("A=1 sudo /bin/sh -c 'echo success'; sudo /bin/true", ['testpw', 'testpw'])
assert status == 0 and output == 'success\n' and len(requests) == 2, (status, output, error)
status, output, error, requests = run('sudo /bin/echo must-not-run', [None])
assert status != 0 and 'must-not-run' not in output, (status, output, error)
for flags in ['-n', '-kn', '--non-interactive']:
    status, output, error, requests = run('sudo ' + flags + ' /bin/echo must-not-run', [])
    assert status != 0 and not requests and not output, (status, output, error)
status, output, error, requests = run('sudo /bin/echo -n success', ['testpw'])
assert status == 0 and output == 'success' and len(requests) == 1, (status, output, error)
status, output, error, requests = run('env -i @bridge@/invoke /usr/bin/sudo /bin/echo success', ['testpw'])
assert status == 0 and output == 'success\n' and len(requests) == 1, (status, output, error)
status, output, error, requests = run('sudo /bin/echo first & sudo /bin/echo second & wait', ['testpw', 'testpw'])
assert status == 0 and sorted(output.splitlines()) == ['first', 'second'] and len(requests) == 2, (status, output, error)
run('sudo /bin/echo must-not-run & sudo /bin/echo must-not-run & wait', [], disconnect=True)
print('PASS: password-free sudo, retry, stdin, single execution, env, parallel sudo, cancellation, options, cleanup')
