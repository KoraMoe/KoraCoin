#!/bin/bash

# Create circuits_build directory if it doesn't exist
mkdir -p circuits_build

# Compile the circuit
circom circuits/PoseidonVRF.circom \
  --r1cs \
  --wasm \
  --sym \
  -o circuits_build \
  -l node_modules

echo "Circuit compiled successfully to circuits_build directory"

echo "Generating Solidity verifier..."

# Navigate to circuits_build directory
cd circuits_build

# Download the existing Powers of Tau file instead of generating it
echo "Downloading existing Powers of Tau file..."
curl -o pot12_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau

# Generate a zk-SNARK proving key and verification key
echo "Generating proving and verification keys..."
snarkjs groth16 setup PoseidonVRF.r1cs pot12_final.ptau PoseidonVRF_0000.zkey

# Generate truly random entropy using OpenSSL
ENTROPY=$(openssl rand -hex 32)
echo "Using secure random entropy: $ENTROPY"
snarkjs zkey contribute PoseidonVRF_0000.zkey PoseidonVRF_0001.zkey --name="First contribution" -v -e="$ENTROPY"
snarkjs zkey export verificationkey PoseidonVRF_0001.zkey verification_key.json

# Generate Solidity verifier
echo "Generating Solidity verifier..."
snarkjs zkey export solidityverifier PoseidonVRF_0001.zkey PoseidonVRF_verifier.sol

echo "Solidity verifier generated at circuits_build/PoseidonVRF_verifier.sol"

# Return to the original directory
cd .. 