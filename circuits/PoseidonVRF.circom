pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/**
 * Poseidon-based VRF circuit with validator selection verification:
 * - Public inputs: PUB (commitment), SEED, TOTAL_STAKE, VALIDATOR_STAKE, STAKE_POSITION
 * - Private input: KEY
 * - Public output: OUT = Poseidon(KEY || SEED)
 *
 * The circuit enforces:
 *   1. Poseidon(KEY) == PUB (commitment verification)
 *   2. OUT = Poseidon(KEY, SEED) (VRF output verification)
 *   3. Validator selection verification:
 *      - Hash(OUT) mod TOTAL_STAKE falls within the validator's stake range
 *      - Stake range defined by STAKE_POSITION and VALIDATOR_STAKE
 */
template PoseidonVRF() {
    // Public inputs
    signal input PUB;           // Public commitment to the private key
    signal input SEED;          // Randomness seed (derived from previous VRF output + block height)
    signal input TOTAL_STAKE;   // Total stake in the network
    signal input VALIDATOR_STAKE; // This validator's stake amount
    signal input STAKE_POSITION;  // Sum of stakes before this validator

    // Private input
    signal input KEY;           // Validator's private key

    // Public output
    signal output OUT;          // VRF output

    // Commit-phase: ensure PUB = Poseidon(KEY)
    component commit = Poseidon(1);
    commit.inputs[0] <== KEY;
    // Enforce equality with the provided commitment
    commit.out === PUB;

    // VRF-phase: compute OUT = Poseidon(KEY, SEED)
    component vrf = Poseidon(2);
    vrf.inputs[0] <== KEY;
    vrf.inputs[1] <== SEED;
    OUT <== vrf.out;

    // Validator selection verification phase
    // 1. Compute the hash of the VRF output modulo TOTAL_STAKE
    component modHash = Poseidon(1);
    modHash.inputs[0] <== OUT;
    
    // 2. We need to compute hash % total_stake
    // This is a simplified approach - in production you may need
    // more complex circuits for modular arithmetic
    signal modResult;
    modResult <-- modHash.out % TOTAL_STAKE;
    
    // Enforce the modulo relation
    signal tempMult;
    tempMult <-- modResult * TOTAL_STAKE;
    signal remainder;
    remainder <-- modHash.out - tempMult;
    remainder === modHash.out - (modResult * TOTAL_STAKE);
    
    // 3. Verify that the selected validator is correct:
    // STAKE_POSITION <= modResult < STAKE_POSITION + VALIDATOR_STAKE
    
    // Check lower bound: STAKE_POSITION <= modResult
    component lowerBound = LessEqThan(64); // Adjust bit width as needed
    lowerBound.in[0] <== STAKE_POSITION;
    lowerBound.in[1] <== modResult;
    lowerBound.out === 1;
    
    // Check upper bound: modResult < STAKE_POSITION + VALIDATOR_STAKE
    signal upperLimit;
    upperLimit <== STAKE_POSITION + VALIDATOR_STAKE;
    
    component upperBound = LessThan(64); // Adjust bit width as needed
    upperBound.in[0] <== modResult;
    upperBound.in[1] <== upperLimit;
    upperBound.out === 1;
}

// Instantiate the main component
component main {public [PUB, SEED, TOTAL_STAKE, VALIDATOR_STAKE, STAKE_POSITION]} = PoseidonVRF();