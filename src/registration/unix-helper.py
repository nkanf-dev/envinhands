#!/usr/bin/env python3
"""Explicit Unix registration writes; no network, privilege escalation, or implicit readiness."""
import base64
import fcntl
import hashlib
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys
import uuid

MAX_FILE = 1024 * 1024

def sha(data):
    return hashlib.sha256(data).hexdigest()

def fsync_dir(fd):
    os.fsync(fd)

def directory(path, create=False, allowed=None):
    if not os.path.isabs(path) or '..' in pathlib.PurePath(path).parts:
        raise ValueError('Invalid directory')
    allowed = {0, os.geteuid()} if allowed is None else allowed
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in pathlib.PurePath(path).parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    fsync_dir(fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            s = os.fstat(nxt)
            safe_sticky = s.st_uid == 0 and bool(s.st_mode & stat.S_ISVTX)
            if s.st_uid not in allowed or ((s.st_mode & 0o022) and not safe_sticky):
                os.close(nxt)
                raise ValueError('Unsafe directory')
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise

def read_file(fd, name, owner, optional=False):
    try:
        f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        if optional:
            return None, None
        raise
    try:
        s = os.fstat(f)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != owner or s.st_nlink != 1 or s.st_mode & 0o022 or s.st_size > MAX_FILE:
            raise ValueError('Unsafe file')
        data = bytearray()
        while len(data) <= MAX_FILE:
            chunk = os.read(f, min(65536, MAX_FILE + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_FILE:
            raise ValueError('File too large')
        return bytes(data), s
    finally:
        os.close(f)

def write_atomic(fd, name, data, uid, gid, mode, previous=None, noclobber=False):
    tmp = '.envinhands-' + uuid.uuid4().hex
    f = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        if os.geteuid() == 0:
            os.fchown(f, uid, gid)
        os.fchmod(f, mode)
        view = memoryview(data)
        while view:
            view = view[os.write(f, view):]
        os.fsync(f)
    finally:
        os.close(f)
    try:
        if noclobber:
            os.link(tmp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        else:
            current, s = read_file(fd, name, uid, optional=True)
            if previous is None:
                if s is not None:
                    raise ValueError('Concurrent file change')
                os.link(tmp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            else:
                if s is None or sha(current) != previous:
                    raise ValueError('Concurrent file change')
                os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
        fsync_dir(fd)
    finally:
        try:
            os.unlink(tmp, dir_fd=fd)
        except FileNotFoundError:
            pass

def lock(fd):
    f = os.open('.envinhands.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
    try:
        s = os.fstat(f)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_nlink != 1 or s.st_mode & 0o077:
            raise ValueError('Unsafe lock')
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return f
    except BaseException:
        os.close(f)
        raise

def validate_key(key):
    if not isinstance(key, str) or not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}', key):
        raise ValueError('Invalid public key')
    data = base64.b64decode(key.split()[1], validate=True)
    if len(data) != 51 or data[:4] != b'\0\0\0\x0b' or data[4:15] != b'ssh-ed25519' or data[15:19] != b'\0\0\0\x20':
        raise ValueError('Invalid public key')
    if base64.b64encode(data).decode() != key.split()[1]:
        raise ValueError('Invalid public key')

def check_policy(visudo, candidate):
    if not os.path.isabs(visudo):
        raise ValueError('Absolute visudo required')
    # Standalone complete policy, never reads system sudoers or follows include directives.
    checked = subprocess.run([visudo, '-c', '-f', '-'], input=b'Defaults env_reset\nroot ALL=(ALL:ALL) ALL\n' + candidate,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
    if checked.returncode != 0:
        raise ValueError('visudo rejected candidate')

def execute(envelope):
    request, options = envelope['request'], envelope.get('options', {})
    if request.get('confirm') is not True or request.get('action') not in ('apply', 'revoke'):
        raise ValueError('Explicit confirmation required')
    op = request.get('operationId')
    if not isinstance(op, str) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}', op):
        raise ValueError('Invalid operation ID')
    fixture = options.get('fixtureRoot')
    if not fixture and (sys.platform not in ('linux', 'darwin') or os.geteuid() != 0):
        raise ValueError('Approved root context required')
    if fixture and (not os.path.isabs(fixture) or fixture == '/'):
        raise ValueError('Invalid fixture root')
    prefix = '/private' if sys.platform == 'darwin' else ''
    state_path = str(pathlib.Path(fixture) / 'state') if fixture else prefix + '/var/lib/envinhands/registrations'
    sudo_path = str(pathlib.Path(fixture) / 'sudoers.d') if fixture else prefix + '/etc/sudoers.d'
    state_fd = directory(state_path, create=True)
    state_lock = lock(state_fd)
    sudo_fd = ssh_fd = home_fd = ssh_lock = None
    receipt = None
    receipt_name = 'registration-' + sha(op.encode()) + '.json'
    def save():
        old, _ = read_file(state_fd, receipt_name, os.geteuid(), optional=True)
        write_atomic(state_fd, receipt_name, json.dumps(receipt, sort_keys=True).encode(), os.geteuid(), os.getegid(), 0o600,
                     previous=sha(old) if old is not None else None)
    try:
        old, _ = read_file(state_fd, receipt_name, os.geteuid(), optional=True)
        if request['action'] == 'apply':
            if old is not None:
                receipt = json.loads(old)
                return {'status': 'partial', 'ready': False,
                        'fixture': bool(fixture), 'receipt': receipt, 'message': 'Existing operation; inspect receipt, no work replayed.'}
            user, key = request.get('user'), request.get('publicKey')
            if not isinstance(user, str) or user == 'root' or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,31}', user):
                raise ValueError('Invalid existing user')
            account = pwd.getpwnam(user)
            validate_key(key)
            uid, gid = (os.geteuid(), os.getegid()) if fixture else (account.pw_uid, account.pw_gid)
            if not fixture and uid == 0:
                raise ValueError('Root account not supported')
            home_path = str(pathlib.Path(fixture) / 'home') if fixture else account.pw_dir
            home_fd = directory(home_path, create=bool(fixture), allowed={0, uid})
            if os.fstat(home_fd).st_uid != uid:
                raise ValueError('Account home ownership mismatch')
            receipt = {'version': 1, 'operationId': op, 'fixture': bool(fixture), 'user': user, 'uid': uid, 'gid': gid,
                       'homePath': home_path, 'sudoersDirectory': sudo_path, 'stage': 'preparing'}
            save()
            try:
                os.mkdir('.ssh', 0o700, dir_fd=home_fd)
                if not fixture:
                    os.chown('.ssh', uid, gid, dir_fd=home_fd, follow_symlinks=False)
                fsync_dir(home_fd)
            except FileExistsError:
                pass
            ssh_fd = os.open('.ssh', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home_fd)
            s = os.fstat(ssh_fd)
            if s.st_uid != uid or s.st_mode & 0o022:
                raise ValueError('Unsafe SSH directory')
            ssh_lock = lock(ssh_fd)
            sudo_fd = directory(sudo_path, create=bool(fixture))
            policy = (user + ' ALL=(ALL:ALL) NOPASSWD: ALL\n').encode()
            check_policy(options.get('visudoPath', '/usr/sbin/visudo'), policy)
            before, existing = read_file(ssh_fd, 'authorized_keys', uid, optional=True)
            original = before or b''
            already = any(line.split()[:2] == key.encode().split() for line in original.splitlines())
            block = (b'' if not original or original.endswith(b'\n') else b'\n') + key.encode() + b' envinhands:' + sha(op.encode()).encode() + b'\n'
            after = original if already else original + block
            sudo_name = 'envinhands-' + sha(op.encode())
            existing_policy, _ = read_file(sudo_fd, sudo_name, os.geteuid(), optional=True)
            if existing_policy is not None:
                raise ValueError('Sudoers destination already exists')
            receipt = {'version': 1, 'operationId': op, 'fixture': bool(fixture), 'user': user, 'uid': uid, 'gid': gid,
                       'homePath': home_path, 'sudoersDirectory': sudo_path, 'sudoersName': sudo_name,
                       'keyAdded': not already, 'keyBlock': base64.b64encode(block).decode() if not already else None,
                       'authorizedKeysExisted': before is not None, 'authorizedKeysBeforeSha256': sha(original),
                       'authorizedKeysAfterSha256': sha(after), 'sudoersSha256': sha(policy),
                       'keyWriteAttempted': False, 'sudoersWriteAttempted': False, 'stage': 'prepared'}
            save()
            if not already:
                receipt['keyWriteAttempted'] = True
                save()
                write_atomic(ssh_fd, 'authorized_keys', after, uid, gid, stat.S_IMODE(existing.st_mode) if existing else 0o600,
                             previous=sha(before) if before is not None else None)
            _, installed_key = read_file(ssh_fd, 'authorized_keys', uid, optional=True)
            receipt['authorizedKeysIdentity'] = [installed_key.st_dev, installed_key.st_ino] if installed_key else None
            receipt['stage'] = 'key-present'
            receipt['sudoersWriteAttempted'] = True
            save()
            write_atomic(sudo_fd, sudo_name, policy, os.geteuid(), os.getegid(), 0o440, noclobber=True)
            _, installed_policy = read_file(sudo_fd, sudo_name, os.geteuid())
            receipt['sudoersIdentity'] = [installed_policy.st_dev, installed_policy.st_ino]
            receipt['stage'] = 'applied'
            save()
            return {'status': 'applied', 'ready': False, 'fixture': bool(fixture), 'receipt': receipt,
                    'message': 'Owned files applied; actual Agent SSH and administrator checks still required.'}
        if old is None:
            raise ValueError('Owned receipt missing')
        receipt = json.loads(old)
        if receipt.get('operationId') != op or receipt.get('fixture') != bool(fixture):
            raise ValueError('Receipt scope mismatch')
        if receipt.get('stage') == 'revoked':
            return {'status': 'revoked', 'ready': False, 'fixture': bool(fixture), 'receipt': receipt, 'message': 'Already revoked.'}
        if not all(k in receipt for k in ('sudoersName', 'sudoersSha256', 'authorizedKeysBeforeSha256')):
            return {'status': 'partial', 'ready': False, 'fixture': bool(fixture), 'receipt': receipt,
                    'message': 'Preparation incomplete; no recorded owned grant to remove. Inspect created directories.'}
        uid, gid = receipt['uid'], receipt['gid']
        home_fd = directory(receipt['homePath'], allowed={0, uid})
        ssh_fd = os.open('.ssh', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home_fd)
        ssh_lock = lock(ssh_fd)
        sudo_fd = directory(receipt['sudoersDirectory'])
        partial = False
        policy, policy_stat = read_file(sudo_fd, receipt['sudoersName'], os.geteuid(), optional=True)
        if policy is not None:
            identity = [policy_stat.st_dev, policy_stat.st_ino]
            if sha(policy) == receipt['sudoersSha256'] and stat.S_IMODE(policy_stat.st_mode) == 0o440 and receipt.get('sudoersWriteAttempted') and identity == receipt.get('sudoersIdentity'):
                check_policy(options.get('visudoPath', '/usr/sbin/visudo'), b'')
                os.unlink(receipt['sudoersName'], dir_fd=sudo_fd)
                fsync_dir(sudo_fd)
            else:
                partial = True
        current, current_stat = read_file(ssh_fd, 'authorized_keys', uid, optional=True)
        if receipt.get('keyAdded') and receipt.get('keyWriteAttempted') and current is not None:
            block = base64.b64decode(receipt['keyBlock'])
            identity = [current_stat.st_dev, current_stat.st_ino]
            if current.count(block) == 1 and identity == receipt.get('authorizedKeysIdentity') and sha(current) == receipt['authorizedKeysAfterSha256']:
                replacement = current.replace(block, b'', 1)
                write_atomic(ssh_fd, 'authorized_keys', replacement, uid, gid, stat.S_IMODE(current_stat.st_mode), previous=sha(current))
            elif sha(current) != receipt['authorizedKeysBeforeSha256']:
                partial = True
        receipt['stage'] = 'partial-revoke' if partial else 'revoked'
        save()
        return {'status': 'partial' if partial else 'revoked', 'ready': False, 'fixture': bool(fixture), 'receipt': receipt,
                'message': 'Changed owned entries retained for review.' if partial else 'Only unchanged owned grant and key block removed.'}
    except BaseException:
        if receipt is not None:
            # Keep earlier durable stage for crash/partial recovery; do not pretend rollback occurred.
            return {'status': 'partial', 'ready': False, 'fixture': bool(fixture), 'receipt': receipt,
                    'message': 'Operation incomplete; inspect the durable receipt before retry or revoke.'}
        raise
    finally:
        for fd in (ssh_lock, ssh_fd, home_fd, sudo_fd, state_lock, state_fd):
            if fd is not None:
                os.close(fd)

def main():
    fixture = False
    try:
        data = sys.stdin.buffer.read(16385)
        if len(data) > 16384:
            raise ValueError('Input too large')
        envelope = json.loads(data)
        fixture = bool(envelope.get('options', {}).get('fixtureRoot'))
        result = execute(envelope)
    except BaseException:
        result = {'status': 'failed', 'ready': False, 'fixture': fixture,
                  'message': 'Unix registration rejected or unavailable; no successful application is claimed.'}
    print(json.dumps(result))
    return 0 if result['status'] in ('applied', 'revoked') else 1

if __name__ == '__main__':
    sys.exit(main())
