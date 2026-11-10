# Runs on a dedicated SSH control channel, never on the command's stdin/stderr.
set -eu
umask 077
dir=$1
owned=0
watcher=
cleanup() {
    trap - EXIT HUP INT TERM
    [ -z "$watcher" ] || kill "$watcher" 2>/dev/null || :
    if [ "$owned" = 1 ]; then
        # Readers whose replies were still queued have no SSH writer to close.
        # Each live askpass owns and removes its PID-named FIFO.
        for reply in "$dir"/reply-*; do
            [ -p "$reply" ] || continue
            pid=${reply##*/reply-}
            case "$pid" in ''|*[!0-9]*) continue;; esac
            kill -TERM "$pid" 2>/dev/null || :
        done
        rm -rf -- "$dir"
    fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir -m 700 "$dir"
owned=1
printf '#!/bin/sh\nexit 0\n' > "$dir/probe"
chmod 700 "$dir/probe"
if ! "$dir/probe" 2>/dev/null; then
    rm -rf -- "$dir"
    owned=0
    dir="$HOME/.${1##*/}"
    mkdir -m 700 "$dir"
    owned=1
    printf '#!/bin/sh\nexit 0\n' > "$dir/probe"
    chmod 700 "$dir/probe"
    "$dir/probe" 2>/dev/null || { printf 'ERROR no executable temporary directory\n'; exit 1; }
fi
rm -f -- "$dir/probe"
real_sudo=$(command -v sudo) || { printf 'ERROR sudo not found\n'; exit 1; }
case "$real_sudo" in /*) ;; *) printf 'ERROR sudo path is not absolute\n'; exit 1;; esac
mkfifo -m 600 "$dir/requests"
printf '%s\n' "$real_sudo" > "$dir/real-sudo"
cat > "$dir/askpass" <<'ASKPASS'
#!/bin/sh
set -eu
umask 077
dir=${0%/*}
reply="$dir/reply-$$"
mkfifo -m 600 "$reply"
trap 'rm -f -- "$reply"' EXIT
trap 'exit 1' HUP INT TERM
identity=$(printf '%s' "$1" | od -An -tx1 | tr -d ' \n')
printf '%s %s %s\n' "$$" "$MARCEL_SUDO_CALL" "$identity" > "$dir/requests"
# The reply channel opens before the app asks the user. SSH disconnect closes
# its writer, so read fails and sudo gets no password.
IFS= read -r password < "$reply" || exit 1
printf '%s\n' "$password"
unset password
ASKPASS
cat > "$dir/sudo" <<'SUDO'
#!/bin/sh
set -eu
dir=${0%/*}
IFS= read -r real_sudo < "$dir/real-sudo"
exec /bin/sh "$dir/invoke" "$real_sudo" "$@"
SUDO
cat > "$dir/invoke" <<'INVOKE'
#!/bin/sh
set -eu
SUDO_ASKPASS=${0%/*}/askpass
export SUDO_ASKPASS
real_sudo=$1
shift
# Inspect only sudo options: `sudo echo -n` must still be able to ask.
needs_value=0
explicit=0
for arg do
    if [ "$needs_value" = 1 ]; then needs_value=0; continue; fi
    case "$arg" in
        --) break;;
        --non-interactive|--stdin|--version|--help) explicit=1;;
        --*=*) ;;
        --user|--group|--prompt|--close-from|--chdir|--chroot|--host|--role|--type|--command-timeout|--other-user) needs_value=1;;
        --*) ;;
        -*)
            flags=${arg#-}
            while [ -n "$flags" ]; do
                flag=${flags%"${flags#?}"}
                flags=${flags#?}
                case "$flag" in
                    n|S|V) explicit=1;;
                    u|g|p|C|D|R|h|r|t|T|U) [ -n "$flags" ] || needs_value=1; break;;
                esac
            done;;
        *=*) ;;
        *) break;;
    esac
done
[ "$explicit" = 0 ] || exec "$real_sudo" "$@"
MARCEL_SUDO_CALL=$$
export MARCEL_SUDO_CALL
exec "$real_sudo" -A -p '%p' "$@"
INVOKE
chmod 700 "$dir/askpass" "$dir/sudo" "$dir/invoke"
parent=$$
exec 4<&0
(cat <&4 >/dev/null; kill -TERM "$parent" 2>/dev/null || :) &
watcher=$!
printf 'READY %s\n' "$(printf '%s' "$dir" | od -An -tx1 | tr -d ' \n')"
exec 5<> "$dir/requests"
while IFS= read -r request <&5; do
    printf '%s\n' "$request"
done
