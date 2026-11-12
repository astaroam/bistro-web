#!/usr/bin/env bash
# Vytvoří soukromý klíč a žádost o certifikát (CSR) pro Pass Type ID. Mac není potřeba.
#   ./scripts/make-csr.sh vas@email.cz
# Výsledek: certs/pass.key (tajné, nikam nenahrávat) a certs/pass.csr (nahrát na developer.apple.com).
set -euo pipefail
EMAIL="${1:?Zadejte e-mail z Apple Developer účtu}"
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -new -newkey rsa:2048 -nodes \
  -keyout certs/pass.key -out certs/pass.csr \
  -subj "/emailAddress=${EMAIL}/CN=eBISTRO Pass/C=CZ"
chmod 600 certs/pass.key
echo "Hotovo. Nahrajte certs/pass.csr v Certificates → + → Pass Type ID Certificate."
echo "Stažený pass.cer převeďte: openssl x509 -inform der -in pass.cer -out certs/pass.pem"
echo "Mezilehlý certifikát Apple: curl -sO https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer && openssl x509 -inform der -in AppleWWDRCAG4.cer -out certs/wwdr.pem"
