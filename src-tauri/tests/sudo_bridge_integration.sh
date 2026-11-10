#!/bin/sh
# Linux/WSL root integration test. All accounts and sudoers changes live in a
# disposable chroot and PID/mount namespaces; the host configuration is untouched.
# Run from the repository root: sh src-tauri/tests/sudo_bridge_integration.sh
set -eu
if [ "${1:-}" != --isolated ]; then
    exec unshare -mpf --mount-proc sh "$0" --isolated
fi
mount --make-rprivate /
repo=$PWD
mkdir -p "$repo/scratch"
root=$(mktemp -d "$repo/scratch/sudo-test-XXXXXX")
mount -t tmpfs -o size=256m tmpfs "$root"
trap 'umount -Rl "$root"; rmdir "$root"' EXIT
apk --root "$root" --initdb --keys-dir /etc/apk/keys \
    --repository https://mirrors.ustc.edu.cn/alpine/v3.22/main \
    --repository https://mirrors.ustc.edu.cn/alpine/v3.22/community \
    add alpine-baselayout busybox musl sudo python3 '!python3-pyc' '!pyc'
mkdir -p "$root/dev" "$root/tmp"
mount --rbind /dev "$root/dev"
mount --make-rslave "$root/dev"
chmod 1777 "$root/tmp"
chroot "$root" /bin/sh -c 'set -e; adduser -D tester; echo tester:testpw | chpasswd; printf "root ALL=(ALL) NOPASSWD: ALL\ntester ALL=(ALL) PASSWD: ALL\ntester ALL=(root) NOPASSWD: /usr/bin/id\nDefaults timestamp_timeout=0\n" > /etc/sudoers; chmod 440 /etc/sudoers'
run_tests() {
    cp "$repo/src-tauri/src/command_exec/sudo_bridge.sh" "$root/tmp/bridge.sh"
    cp "$repo/src-tauri/tests/sudo_bridge_integration.py" "$root/tmp/check.py"
    chroot "$root" /usr/bin/python3 /tmp/check.py
}
run_tests
mount -t tmpfs -o noexec,mode=1777 tmpfs "$root/tmp"
run_tests
