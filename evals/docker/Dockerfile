# Marcel SSH 评测靶机镜像：Debian bookworm + sshd（无 systemd）
FROM debian:bookworm-slim

# 仅供本机容器使用的测试口令
ARG ROOT_PASSWORD=marcel-eval
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Asia/Shanghai DEBIAN_FRONTEND=noninteractive

# apt 源：优先清华镜像，更新失败则回落官方源
RUN set -e; \
    cp -a /etc/apt/sources.list.d/debian.sources /tmp/debian.sources.bak; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources; \
    if ! apt-get update; then \
        cp -a /tmp/debian.sources.bak /etc/apt/sources.list.d/debian.sources; \
        apt-get update; \
    fi; \
    apt-get install -y --no-install-recommends \
        openssh-server sudo curl wget procps psmisc iproute2 net-tools lsof nginx python3 cron jq less vim-tiny nano \
        file tar gzip bzip2 xz-utils unzip zip git rsync ca-certificates tree findutils grep sed gawk coreutils util-linux \
        netcat-openbsd tzdata g++ make; \
    rm -rf /var/lib/apt/lists/*

RUN set -e; \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime; echo Asia/Shanghai > /etc/timezone; \
    mkdir -p /run/sshd; \
    ssh-keygen -A; \
    echo "root:${ROOT_PASSWORD}" | chpasswd; \
    sed -i '/^#\?PermitRootLogin/d; /^#\?PasswordAuthentication/d; /^#\?UseDNS/d' /etc/ssh/sshd_config; \
    rm -f /etc/ssh/ssh_host_rsa_key* /etc/ssh/ssh_host_ecdsa_key*; \
    printf 'PermitRootLogin yes\nPasswordAuthentication yes\nUseDNS no\nHostKey /etc/ssh/ssh_host_ed25519_key\n' >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
