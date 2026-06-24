pragma circom 2.1.6;

// ---------------------------------------------------------------------------
// D2 — UPDATE_GRADIENT honesty proof (trainer side).
// Proves that a trainer (e.g. B) computed  x' = x + y  honestly, on the secret
// y it has committed to, WITHOUT revealing y.
//
// Relation R (design doc "Blockchain Audit Layer..." §D2):
//   (x, x_prime, commit, y_max ; y, s) :
//       commit  = Poseidon(y, s)     // y is bound to a ZK-friendly commitment
//       x_prime = x + y              // correct formula
//       0 <= y <= y_max              // range-check (anti-T1, anti field-wrap)
//
//   Public  inputs : x, x_prime, commit, y_max
//   Private witness: y (secret gradient), s (salt, reused across rounds)
//
// Why Poseidon and not SHA-256: the doc §D2 trade-offs note SHA-256 is very
// expensive inside a circuit; the commitment must use a ZK-friendly hash.
// nBits bounds the range-check window; y and y_max must fit in nBits bits.
// ---------------------------------------------------------------------------

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";

template UpdateGradient(nBits) {
    // --- private witness ---
    signal input y;        // the secret gradient (never revealed)
    signal input s;        // salt for the commitment

    // --- public inputs ---
    signal input x;        // value A broadcast this round
    signal input x_prime;  // the update the trainer published (x + y)
    signal input commit;   // Poseidon(y, s), anchored once and reused per round
    signal input y_max;    // range-check upper bound from the config/version

    // (1) commitment binds the secret:  commit == Poseidon(y, s)
    component H = Poseidon(2);
    H.inputs[0] <== y;
    H.inputs[1] <== s;
    commit === H.out;

    // (2) correct formula:  x_prime == x + y
    x_prime === x + y;

    // (3) range-check  0 <= y <= y_max.
    //     Num2Bits pins both into [0, 2^nBits) -> non-negative and bounded,
    //     which is what makes LessEqThan sound and blocks field wraparound.
    component yb = Num2Bits(nBits);
    yb.in <== y;
    component mb = Num2Bits(nBits);
    mb.in <== y_max;

    component le = LessEqThan(nBits);
    le.in[0] <== y;
    le.in[1] <== y_max;
    le.out === 1;
}

// Stage-1 scalar: 64-bit range window is ample for the demo values.
component main { public [x, x_prime, commit, y_max] } = UpdateGradient(64);
