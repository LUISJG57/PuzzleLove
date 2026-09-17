# Runs the Ansible playbook from Windows through the pinned toolchain image (no local Ansible needed).
#   powershell -ExecutionPolicy Bypass -File .\deploy\ansible\run.ps1 --check --diff   # dry run
#   powershell -ExecutionPolicy Bypass -File .\deploy\ansible\run.ps1                   # apply
# Prompts for the sudo password of the deploy user (-K). Your ~/.ssh keys are mounted read-only.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

docker build -q -t puzzlelove-ansible $here | Out-Null
docker run --rm -it `
  -v "${here}:/ansible" `
  -v "$env:USERPROFILE\.ssh:/host-ssh:ro" `
  -e ANSIBLE_CONFIG=/ansible/ansible.cfg `
  puzzlelove-ansible ansible-playbook site.yml -K @args
