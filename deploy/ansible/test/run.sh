#!/usr/bin/env bash
# Runs the playbook twice against a throwaway systemd container and fails unless the second run changes nothing.
#   bash deploy/ansible/test/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths untouched

NET=puzzlelove-ansible-test
WORK=test/.work
cleanup() { docker rm -f ansible-target >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

mkdir -p "$WORK"
rm -f "$WORK"/test_key*
ssh-keygen -q -t ed25519 -N '' -C ansible-test -f "$WORK/test_key"
cp "$WORK/test_key.pub" test/test_key.pub

docker build -q -t puzzlelove-ansible .
docker build -q -t puzzlelove-ansible-target test
rm test/test_key.pub
docker network create "$NET" >/dev/null
docker run -d --name ansible-target --hostname target --network "$NET" \
  --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw puzzlelove-ansible-target >/dev/null
sleep 5

# The test key replaces the real ones so the hardened sshd still accepts us.
play() {
  docker run --rm --network "$NET" -v "$(pwd -W 2>/dev/null || pwd):/ansible" \
    -e ANSIBLE_CONFIG=/ansible/ansible.cfg puzzlelove-ansible \
    sh -c 'chmod 600 /ansible/test/.work/test_key 2>/dev/null; cp /ansible/test/.work/test_key /tmp/k && chmod 600 /tmp/k &&
      ansible-playbook -i test/inventory.yml site.yml \
        -e ansible_ssh_private_key_file=/tmp/k \
        -e "{\"deploy_authorized_keys\": [\"$(cat test/.work/test_key.pub)\"]}"'
}

echo "==> first run"
play | tee "$WORK/run1.log" | tail -n 4
echo "==> second run (must report changed=0)"
play | tee "$WORK/run2.log" | tail -n 4
grep -Eq 'changed=0 +unreachable=0 +failed=0' "$WORK/run2.log" || { echo "NOT IDEMPOTENT"; grep -E '^changed:' "$WORK/run2.log"; exit 1; }

echo "==> checks on target"
docker exec ansible-target sh -c '
  sshd -T | grep -E "^(permitrootlogin|passwordauthentication|allowusers|maxauthtries) " ;
  ufw status | head -n 8 ;
  systemctl is-active fail2ban docker ;
  docker info --format "logging={{.LoggingDriver}} live-restore={{.LiveRestoreEnabled}}" ;
  id luis'
echo "==> idempotent: OK"
