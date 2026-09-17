# Throwaway Ubuntu 24.04 target with systemd and sshd, shaped like a fresh Hostinger VPS
# after the deploy user was created. Used to check that the playbook converges and is idempotent.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server sudo python3 iptables kmod \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -s /bin/bash luis \
  && echo 'luis ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/luis \
  && systemctl enable ssh
COPY test_key.pub /home/luis/.ssh/authorized_keys
RUN chown -R luis:luis /home/luis/.ssh && chmod 700 /home/luis/.ssh && chmod 600 /home/luis/.ssh/authorized_keys
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
