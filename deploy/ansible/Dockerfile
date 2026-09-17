# Pinned Ansible toolchain, so the playbook runs the same from Windows, WSL or CI.
FROM python:3.13-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir ansible==14.4.0 ansible-lint==26.8.0
WORKDIR /ansible
# Keys are mounted read-only from the host; SSH refuses keys with loose permissions, so copy them first.
ENTRYPOINT ["sh", "-c", "if [ -d /host-ssh ]; then mkdir -p -m 700 ~/.ssh && cp /host-ssh/id_* /host-ssh/known_hosts ~/.ssh/ 2>/dev/null; chmod 600 ~/.ssh/* 2>/dev/null; fi; exec \"$@\"", "--"]
CMD ["ansible-playbook", "--version"]
