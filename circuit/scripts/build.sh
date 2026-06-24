#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Full ZK build pipeline for D2 (Groth16 / snarkjs).
#   1. Powers of Tau (phase 1, universal — built once, reused by both circuits)
#   2. per circuit: compile -> groth16 setup -> phase-2 contribution
#                   -> export proving key (.zkey) + verification key (.vkey.json)
#                   -> export Solidity verifier (.verifier.sol, for on-chain use)
#
# Outputs that are meant to be reused (the point of this task):
#   keys/<circuit>.zkey       = PROVING KEY  (pk)
#   keys/<circuit>.vkey.json  = VERIFICATION KEY (vk)
#
# Re-runnable: the (slow) Powers of Tau step is cached; delete ptau/ to redo it.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."        # -> circuit/

CIRCOM=./bin/circom
SNARKJS=../node_modules/.bin/snarkjs
LIB=../node_modules/circomlib/circuits
POWER=12                        # 2^12 = 4096 constraints, ample (max circuit ~717)
PTAU="ptau/pot${POWER}_final.ptau"
CIRCUITS=("update_gradient" "update_model")

mkdir -p ptau keys proofs inputs build

# ---- Phase 1: Powers of Tau (universal setup, reusable across circuits) ----
if [ ! -f "$PTAU" ]; then
  echo "==> [phase 1] Powers of Tau (power $POWER)"
  "$SNARKJS" powersoftau new bn128 "$POWER" ptau/pot_0000.ptau -v
  "$SNARKJS" powersoftau contribute ptau/pot_0000.ptau ptau/pot_0001.ptau \
    --name="fl-psi-stage1" -v -e="$(head -c 64 /dev/urandom | base64)"
  "$SNARKJS" powersoftau prepare phase2 ptau/pot_0001.ptau "$PTAU" -v
  rm -f ptau/pot_0000.ptau ptau/pot_0001.ptau
else
  echo "==> [phase 1] reusing cached $PTAU"
fi

# ---- Phase 2: per-circuit compile + Groth16 setup ----
for c in "${CIRCUITS[@]}"; do
  echo ""
  echo "==> [compile] $c"
  mkdir -p "build/$c"
  "$CIRCOM" "src/$c.circom" --r1cs --wasm --sym -o "build/$c" -l "$LIB"

  echo "==> [setup] groth16 -> proving key keys/$c.zkey"
  "$SNARKJS" groth16 setup "build/$c/$c.r1cs" "$PTAU" "keys/${c}_0000.zkey"
  "$SNARKJS" zkey contribute "keys/${c}_0000.zkey" "keys/$c.zkey" \
    --name="fl-psi phase2" -v -e="$(head -c 64 /dev/urandom | base64)"
  rm -f "keys/${c}_0000.zkey"

  echo "==> [export] verification key keys/$c.vkey.json"
  "$SNARKJS" zkey export verificationkey "keys/$c.zkey" "keys/$c.vkey.json"

  echo "==> [export] Solidity verifier keys/$c.verifier.sol"
  "$SNARKJS" zkey export solidityverifier "keys/$c.zkey" "keys/$c.verifier.sol"
done

echo ""
echo "DONE."
echo "  proving keys (pk)      : keys/update_gradient.zkey , keys/update_model.zkey"
echo "  verification keys (vk) : keys/update_gradient.vkey.json , keys/update_model.vkey.json"
